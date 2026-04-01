/**
 * Triage Handler Lambda
 *
 * Scans open issues across monitored repositories and auto-labels qualifying issues:
 * - Skips issues that already have agent-related, triage, or manual labels
 * - Skips issues with labels: manual, discussion, architecture, escalation:queue, bot-summary
 * - For issues with ≤3 acceptance criteria checkboxes: auto-adds 'agent' label
 * - Logs all decisions (skipped/labeled) to CloudWatch
 */

import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import type { GitHubAppConfig } from "./types";
import { getInstallationToken } from "./types";

const ssm = new SSMClient({});

const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

// Monitored repositories for triage (comma-separated)
const MONITORED_REPOS = (process.env.MONITORED_REPOS || "").split(",").filter(r => r.trim());

// Default repos if not specified
const DEFAULT_REPOS = [
  "cenetex/aws-swarm",
  "cenetex/kyro",
  "cenetex/raticross",
  "cenetex/ratibot",
  "cenetex/litigation",
  "cenetex/agent",
  "cenetex/governance",
];

const MAX_ACCEPTANCE_CRITERIA = 3;

// Labels to skip if already present
const SKIP_LABELS = [
  "agent",
  "agent:running",
  "agent:waiting",
  "agent:failed",
  "agent:succeeded",
  "needs:triage",
  "needs:manual",
  "manual",
  "discussion",
  "architecture",
  "escalation:queue",
  "bot-summary",
];

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
      "User-Agent": "github-agent-triage",
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

/**
 * Counts acceptance criteria checkboxes in issue body
 */
function countAcceptanceCriteria(body: string): number {
  if (!body) return 0;
  const checkboxPattern = /^\s*[-*]\s*\[\s*[xX ]?\s*\]/gm;
  const matches = body.match(checkboxPattern);
  return matches ? matches.length : 0;
}

/**
 * Checks if issue should be skipped (has any exclude labels)
 */
function shouldSkipIssue(issueLabels: any[]): boolean {
  const labelNames = issueLabels.map((label: any) => label.name);
  return SKIP_LABELS.some((skipLabel) =>
    labelNames.includes(skipLabel)
  );
}

/**
 * Adds a label to the issue
 */
async function addLabel(
  repo: string,
  issueNumber: number,
  label: string,
  token: string
): Promise<void> {
  try {
    await githubRequest(
      `/repos/${repo}/issues/${issueNumber}/labels`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      },
      [200]
    );
    console.log(`Added label '${label}' to ${repo}#${issueNumber}`);
  } catch (error) {
    console.warn(`Failed to add label '${label}' to ${repo}#${issueNumber}:`, error);
  }
}

/**
 * Scans a single repository for issues needing triage
 */
async function scanRepository(repo: string, token: string): Promise<void> {
  console.log(`Scanning repository: ${repo}`);

  try {
    // Get all open issues (not PRs)
    const response = await githubRequest(
      `/repos/${repo}/issues?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];

    for (const issue of issues) {
      // Skip pull requests
      if (issue.pull_request) {
        console.log(`Skipping PR #${issue.number}`);
        continue;
      }

      const issueNumber = issue.number;

      // Check if issue should be skipped
      if (shouldSkipIssue(issue.labels)) {
        const labelNames = issue.labels
          .map((l: any) => l.name)
          .filter((name: string) => SKIP_LABELS.includes(name));
        console.log(
          `Issue #${issueNumber}: Skipped (has skip labels: ${labelNames.join(", ")})`
        );
        continue;
      }

      // Count acceptance criteria
      const criteria = countAcceptanceCriteria(issue.body);

      if (criteria <= MAX_ACCEPTANCE_CRITERIA) {
        console.log(
          `Issue #${issueNumber}: Qualifying for auto-label (${criteria} criteria ≤ ${MAX_ACCEPTANCE_CRITERIA})`
        );
        await addLabel(repo, issueNumber, "agent", token);
      } else {
        console.log(
          `Issue #${issueNumber}: Skipped (${criteria} criteria > ${MAX_ACCEPTANCE_CRITERIA})`
        );
      }
    }

  } catch (error) {
    console.error(`Error scanning repository ${repo}:`, error);
    // Continue with other repos on error
  }
}

/**
 * Main handler function triggered by EventBridge
 */
export async function handler() {
  console.log("Triage handler triggered");

  try {
    // Get credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    const appConfig: GitHubAppConfig = {
      appId,
      privateKey,
    };

    // Determine which repos to scan
    const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;

    // Get token for first repo to use across all queries
    const githubToken = await getInstallationToken(repos[0].split("/")[0], repos[0].split("/")[1], appConfig);

    // Scan each repository
    for (const repo of repos) {
      await scanRepository(repo, githubToken);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Triage handler completed",
        repos_scanned: repos.length,
      }),
    };

  } catch (error) {
    console.error("Triage handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
}
