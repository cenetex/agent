import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
} from "./types";

/**
 * Canary Handler Lambda
 *
 * Exercises the real dispatch chain end-to-end once a day. Static checks
 * (shell syntax, tsc, connectivity) report each component healthy in
 * isolation; only a real dispatch proves the chain: webhook → Fargate →
 * auth → model → tool execution → PR.
 *
 * Each run:
 * 1. Checks the previous canary issue's outcome (labels + age).
 * 2. On failure, opens or appends to an alert issue routed to the
 *    escalation queue.
 * 3. Dispatches today's canary issue (labeled `agent`) and records it.
 *
 * See issue #612 for the outage that motivated this: the pipeline was
 * silently dead for two days while every static check passed.
 */

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

const CANARY_REPO_OWNER = "cenetex";
const CANARY_REPO_NAME = "agent";
const CANARY_STATE_KEY = "canary/state.json";
const CANARY_TITLE = "Canary: daily dispatch chain check";
const ALERT_TITLE_PREFIX = "🚨 Canary alert: agent dispatch chain broken";
const STALE_AFTER_MINUTES = 120;

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

async function githubRequest(
  path: string,
  token: string,
  init: RequestInit,
  expectedStatuses: number[]
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-agent-canary",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!expectedStatuses.includes(response.status)) {
    const responseBody = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${responseBody}`
    );
  }

  return response;
}

interface CanaryState {
  issue_number: number;
  dispatched_at: string;
}

async function loadCanaryState(): Promise<CanaryState | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: CANARY_STATE_KEY })
    );
    if (!result.Body) return null;
    return JSON.parse(await result.Body.transformToString()) as CanaryState;
  } catch (error: any) {
    if (error.name === "NoSuchKey") return null;
    throw error;
  }
}

async function saveCanaryState(state: CanaryState): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: CANARY_STATE_KEY,
      Body: JSON.stringify(state, null, 2),
      ContentType: "application/json",
    })
  );
}

async function getIssue(
  issueNumber: number,
  token: string
): Promise<any> {
  const response = await githubRequest(
    `/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/issues/${issueNumber}`,
    token,
    { method: "GET" },
    [200]
  );
  return response.json();
}

function labelNames(issue: any): string[] {
  return (issue.labels ?? []).map((l: any) => l.name ?? l);
}

function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

/**
 * Classifies the previous canary issue. Returns null while the canary is
 * still legitimately in flight (do not dispatch a duplicate).
 */
function classifyCanary(issue: any): { outcome: "pass" | "fail"; detail: string } | null {
  const labels = labelNames(issue);
  const has = (name: string) => labels.includes(name);

  if (has("agent:succeeded")) {
    return { outcome: "pass", detail: "canary completed successfully" };
  }
  if (has("agent:failed")) {
    return { outcome: "fail", detail: "canary task reported agent:failed" };
  }
  if (issue.state === "closed" && !has("agent:succeeded")) {
    return { outcome: "fail", detail: "canary issue closed without agent:succeeded" };
  }
  if (has("agent:waiting")) {
    // The chain itself worked (model called, tools ran, GitHub reachable);
    // a trivial canary should never need to ask a question, so note it.
    return { outcome: "pass", detail: "canary ended agent:waiting — chain works but the task was not completed" };
  }

  const age = minutesSince(issue.created_at);
  if (has("agent:running") && age > STALE_AFTER_MINUTES) {
    return { outcome: "fail", detail: `canary stuck in agent:running for ${Math.round(age)} minutes` };
  }
  if (has("agent") && !has("agent:running") && age > STALE_AFTER_MINUTES) {
    return { outcome: "fail", detail: `canary never dispatched (still labeled agent after ${Math.round(age)} minutes) — webhook or launch path is broken` };
  }

  // Still in flight — check back on the next run
  return null;
}

async function findOpenAlertIssue(token: string): Promise<number | null> {
  const response = await githubRequest(
    `/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/issues?labels=escalation:queue&state=open&per_page=100`,
    token,
    { method: "GET" },
    [200]
  );
  const issues = (await response.json()) as any[];
  for (const issue of issues) {
    if ((issue.title as string).startsWith(ALERT_TITLE_PREFIX)) {
      return issue.number;
    }
  }
  return null;
}

async function createAlertIssue(token: string, detail: string, canaryIssue: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const body = `The daily canary failed on ${today}, which means the agent dispatch chain is broken end-to-end. Static checks pass in isolation; only a real dispatch exercises the full path (webhook → Fargate → auth → model → tool execution → PR).

**Failed canary:** #${canaryIssue}
**Observed:** ${detail}

**Likely stages to check (in order):**
1. Webhook handler received the labeled event (API Gateway + Lambda logs)
2. Fargate task launched and reached auth (task network mode, subnets)
3. Model call succeeded (OpenRouter key, credits)
4. Tool execution not sandbox-blocked (Codex sandbox vs Fargate)
5. PR created and labels updated

Previous incidents of this class: #612 (2026-09-01 → 2026-09-02 silent outage).`;

  // Dedupe: append to an existing open alert instead of stacking duplicates
  const existing = await findOpenAlertIssue(token);
  if (existing) {
    await githubRequest(
      `/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/issues/${existing}/comments`,
      token,
      { method: "POST", body: JSON.stringify({ body }) },
      [201]
    );
    return;
  }

  await githubRequest(
    `/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/issues`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        title: `${ALERT_TITLE_PREFIX} ${new Date().toISOString().slice(0, 10)}`,
        body,
        labels: ["escalation:queue"],
      }),
    },
    [201]
  );
}

const CANARY_PROMPT = `Canary task: exercise the full dispatch chain with a trivial change.

## Task
1. Append one line \`canary <current UTC date>\` to \`docs/canary-log.md\` (create the file if it does not exist).
2. Open a pull request titled "Canary: <current UTC date>" containing only that change.
3. Do nothing else. Do not close this issue.

This issue exists to prove the dispatch chain works end-to-end: webhook → Fargate → auth → model → tool execution → PR. If you can read this task and open that PR, the pipeline is healthy.`;

async function dispatchCanary(token: string): Promise<number> {
  const response = await githubRequest(
    `/repos/${CANARY_REPO_OWNER}/${CANARY_REPO_NAME}/issues`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        title: CANARY_TITLE,
        body: CANARY_PROMPT,
        labels: ["agent"],
      }),
    },
    [201]
  );

  const issue = (await response.json()) as any;
  return issue.number;
}

export async function handler(): Promise<{ dispatched: number | null; alert: boolean }> {
  console.log("Starting canary handler");

  const [appId, privateKey] = await Promise.all([
    getParameter(GITHUB_APP_ID_PARAM),
    getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
  ]);
  const jwt = createGitHubAppJWT(appId, privateKey);
  const installationId = await getInstallationId(CANARY_REPO_OWNER, CANARY_REPO_NAME, jwt);
  const tokenResult = await createInstallationToken(installationId, jwt);
  const token = tokenResult.token;

  // 1. Check the previous canary, if any
  const state = await loadCanaryState();
  let alert = false;
  if (state) {
    const issue = await getIssue(state.issue_number, token);
    const verdict = classifyCanary(issue);
    if (verdict) {
      console.log(`Previous canary #${state.issue_number}: ${verdict.outcome} (${verdict.detail})`);
      if (verdict.outcome === "fail") {
        alert = true;
        await createAlertIssue(token, verdict.detail, state.issue_number);
      }
    } else {
      console.log(`Previous canary #${state.issue_number} still in flight; skipping new dispatch`);
      return { dispatched: null, alert: false };
    }
  }

  // 2. Dispatch today's canary
  const issueNumber = await dispatchCanary(token);
  await saveCanaryState({ issue_number: issueNumber, dispatched_at: new Date().toISOString() });
  console.log(`Dispatched canary issue #${issueNumber}`);

  return { dispatched: issueNumber, alert };
}
