/**
 * Auto-Triage Handler Lambda
 *
 * Scans open issues across monitored repos and automatically handles triage:
 * - Auto-labels agent-sized issues (≤3 acceptance criteria)
 * - Breaks down medium issues (4-6 criteria) into sub-issues using Claude Haiku
 * - Marks large/complex issues for manual triage
 * - Enriches deploy failure issues with workflow logs
 * - Respects credit balance before labeling
 */

import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { GitHubAppConfig, CreditBalance } from "./types";
import { getInstallationToken, getModelCost } from "./types";
import { Anthropic } from "@anthropic-ai/sdk";

const ssm = new SSMClient({});
const s3 = new S3Client({});

const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

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

// Labels to skip during triage
const SKIP_LABELS = ["manual", "discussion", "architecture", "escalation:queue"];

// Acceptance criteria thresholds
const AGENT_READY_THRESHOLD = 3;
const BREAKDOWN_THRESHOLD = 6;

/**
 * Handler identifier for idempotency
 */
const HANDLER_IDENTIFIER = "auto-triage-handler";

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
 * Checks if issue has any agent-related labels
 */
function hasAgentLabels(labels: any[]): boolean {
  return labels.some((label: any) => {
    const name = label.name || label;
    return name === "agent" || name.startsWith("agent:");
  });
}

/**
 * Checks if issue should be skipped during triage
 */
function shouldSkip(issue: any): boolean {
  // Has agent labels already
  if (hasAgentLabels(issue.labels)) {
    return true;
  }

  // Has skip labels
  if (issue.labels.some((label: any) => {
    const name = label.name || label;
    return SKIP_LABELS.includes(name);
  })) {
    return true;
  }

  // Is pull request
  if (issue.pull_request) {
    return true;
  }

  return false;
}

/**
 * Checks if issue is a deploy failure
 */
function isDeployFailure(issue: any): boolean {
  const title = (issue.title || "").toLowerCase();
  const body = (issue.body || "").toLowerCase();
  return (
    title.includes("deploy") ||
    title.includes("workflow") ||
    title.includes("ci") ||
    body.includes("workflow run") ||
    body.includes("action failed")
  );
}

/**
 * Checks if handler already commented on this issue
 */
async function hasTriageComment(
  repo: string,
  issueNumber: number,
  token: string
): Promise<boolean> {
  try {
    const response = await githubRequest(
      `/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const comments = await response.json() as any[];
    return comments.some((comment: any) =>
      comment.body.includes(HANDLER_IDENTIFIER)
    );
  } catch (error) {
    console.warn(`Failed to check triage comments for ${repo}#${issueNumber}:`, error);
    return false;
  }
}

/**
 * Gets the credit balance for a repository
 */
async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const balancePath = `credits/${repoSlug}/balance.json`;
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: balancePath,
      })
    );

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as CreditBalance;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      console.log(`No credit balance found for ${repoSlug}`);
      return null;
    }
    throw error;
  }
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
 * Breaks down an issue using Claude Haiku
 */
async function breakDownIssue(
  issue: any,
  apiKey: string
): Promise<string[]> {
  try {
    const client = new Anthropic({
      apiKey,
    });

    const prompt = `You are a technical triage assistant. The following issue has too many acceptance criteria and should be broken down into smaller, more focused issues.

Issue Title: ${issue.title}
Current Criteria Count: ${countAcceptanceCriteria(issue.body)}

Issue Body:
${issue.body}

Your task: Generate 2-4 focused sub-issue titles that break down this larger issue. Each sub-issue should:
- Have ≤3 acceptance criteria when fully broken down
- Be self-contained and actionable
- Keep dependencies clear (e.g., "Part 1: Enable feature flag" before "Part 2: Deploy to production")

Return ONLY a JSON array of objects like:
[
  {"title": "Part 1: ...", "criteria_count": 3},
  {"title": "Part 2: ...", "criteria_count": 2}
]

Do not include markdown formatting, just valid JSON.`;

    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const textContent = response.content.find(c => c.type === "text");
    if (!textContent || textContent.type !== "text") {
      throw new Error("No text content in Claude response");
    }

    // Extract JSON from response
    const jsonMatch = textContent.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("Could not extract JSON from Claude response:", textContent.text);
      return [];
    }

    const subIssues = JSON.parse(jsonMatch[0]) as Array<{title: string; criteria_count: number}>;
    return subIssues.map(s => s.title);
  } catch (error) {
    console.error("Failed to break down issue with Claude:", error);
    return [];
  }
}

/**
 * Creates a sub-issue
 */
async function createSubIssue(
  repo: string,
  parentIssueNumber: number,
  title: string,
  token: string
): Promise<number | null> {
  try {
    const body = `This is part of a larger issue: #${parentIssueNumber}

Please update this issue with acceptance criteria (≤3 checkboxes).`;

    const response = await githubRequest(
      `/repos/${repo}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title,
          body,
          labels: ["triage"], // Mark for manual triage until criteria are set
        }),
      },
      [201]
    );

    const createdIssue = await response.json() as any;
    return createdIssue.number;
  } catch (error) {
    console.error(`Failed to create sub-issue for ${repo}#${parentIssueNumber}:`, error);
    return null;
  }
}

/**
 * Posts a comment about triage action
 */
async function postTriageComment(
  repo: string,
  issueNumber: number,
  message: string,
  token: string
): Promise<void> {
  try {
    const body = `${message}\n\n<!-- ${HANDLER_IDENTIFIER} -->`;

    await githubRequest(
      `/repos/${repo}/issues/${issueNumber}/comments`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      },
      [201]
    );

    console.log(`Posted triage comment on ${repo}#${issueNumber}`);
  } catch (error) {
    console.warn(`Failed to post triage comment on ${repo}#${issueNumber}:`, error);
  }
}

/**
 * Enriches deploy failure issue with workflow logs
 */
async function enrichDeployFailure(
  repo: string,
  issue: any,
  token: string
): Promise<void> {
  try {
    // Try to extract workflow run ID from issue body
    const runIdMatch = (issue.body || "").match(/workflow run (\d+)/i) ||
                       (issue.body || "").match(/run[\/\s]+id[:\s]+(\d+)/i);

    if (!runIdMatch) {
      console.log(`${repo}#${issue.number}: Could not find workflow run ID in issue body`);
      return;
    }

    const runId = runIdMatch[1];
    const [owner, repoName] = repo.split("/");

    // Get workflow run details
    const runResponse = await githubRequest(
      `/repos/${repo}/actions/runs/${runId}`,
      token,
      { method: "GET" },
      [200, 404]
    );

    if (runResponse.status === 404) {
      console.log(`${repo}#${issue.number}: Workflow run ${runId} not found`);
      return;
    }

    const workflowRun = await runResponse.json() as any;

    // Get job logs
    const jobsResponse = await githubRequest(
      `/repos/${repo}/actions/runs/${runId}/jobs`,
      token,
      { method: "GET" },
      [200]
    );

    const jobs = await jobsResponse.json() as any;
    let errorSummary = "";

    for (const job of jobs.jobs) {
      if (job.status === "completed" && job.conclusion === "failure") {
        // Extract error from job name and conclusion
        errorSummary += `- **${job.name}**: ${job.conclusion}\n`;
      }
    }

    if (!errorSummary) {
      console.log(`${repo}#${issue.number}: No failed jobs found in workflow run`);
      return;
    }

    // Update issue body with error details
    const newBody = `${issue.body || ""}\n\n## Workflow Failure Details\n\n${errorSummary}\n\n_Enriched by auto-triage handler_`;

    await githubRequest(
      `/repos/${repo}/issues/${issue.number}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ body: newBody }),
      },
      [200]
    );

    console.log(`Enriched deploy failure ${repo}#${issue.number} with workflow details`);
  } catch (error) {
    console.warn(`Failed to enrich deploy failure ${repo}#${issue.number}:`, error);
  }
}

/**
 * Scans a single repository for issues needing triage
 */
async function scanRepository(
  repo: string,
  token: string,
  appConfig: GitHubAppConfig,
  anthropicApiKey: string
): Promise<void> {
  console.log(`Scanning repository: ${repo}`);

  try {
    // Get credit balance for this repo
    const creditBalance = await getCreditBalance(repo);
    const hasCredits = !creditBalance || creditBalance.current_balance > 0;

    // Get all open issues WITHOUT agent or agent:* labels
    const response = await githubRequest(
      `/repos/${repo}/issues?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const allIssues = await response.json() as any[];

    for (const issue of allIssues) {
      // Skip if should be skipped
      if (shouldSkip(issue)) {
        continue;
      }

      const issueNumber = issue.number;
      const criteria = countAcceptanceCriteria(issue.body);

      // Check if already has triage comment (idempotency)
      const hasComment = await hasTriageComment(repo, issueNumber, token);
      if (hasComment) {
        console.log(`Issue #${issueNumber}: Already triaged, skipping`);
        continue;
      }

      // Handle deploy failures
      if (isDeployFailure(issue)) {
        console.log(`Issue #${issueNumber}: Deploy failure detected`);
        await enrichDeployFailure(repo, issue, token);

        // If enrichment succeeded and criteria ≤3 and has credits, auto-label
        if (criteria <= AGENT_READY_THRESHOLD && hasCredits) {
          await addLabel(repo, issueNumber, "agent", token);
          await postTriageComment(
            repo,
            issueNumber,
            `✅ **Auto-triaged**: Enriched deploy failure with workflow details and labeled as agent-ready.\n\nAcceptance criteria: ${criteria}/${AGENT_READY_THRESHOLD}`,
            token
          );
        }
        continue;
      }

      // Criteria ≤3: Ready for agent immediately
      if (criteria <= AGENT_READY_THRESHOLD) {
        if (!hasCredits) {
          console.log(`Issue #${issueNumber}: Would label as agent but repo has no credits`);
          continue;
        }

        await addLabel(repo, issueNumber, "agent", token);
        await postTriageComment(
          repo,
          issueNumber,
          `✅ **Auto-triaged**: Issue is agent-ready.\n\nAcceptance criteria: ${criteria}/${AGENT_READY_THRESHOLD}`,
          token
        );
      }
      // Criteria 4-6: Break down into sub-issues
      else if (criteria > AGENT_READY_THRESHOLD && criteria <= BREAKDOWN_THRESHOLD) {
        console.log(
          `Issue #${issueNumber}: ${criteria} acceptance criteria (5-6 range, will break down)`
        );

        if (!hasCredits) {
          console.log(`Issue #${issueNumber}: Skipping breakdown - repo has no credits`);
          await addLabel(repo, issueNumber, "needs:triage", token);
          await postTriageComment(
            repo,
            issueNumber,
            `⚠️ **Manual triage needed**: This issue has ${criteria} acceptance criteria (recommended max: ${AGENT_READY_THRESHOLD}). ❌ **Insufficient credits to auto-break down.**\n\nPlease manually break this into smaller issues or add credits.`,
            token
          );
          continue;
        }

        // Break down using Claude
        const subIssueTitles = await breakDownIssue(issue, anthropicApiKey);

        if (subIssueTitles.length > 0) {
          const subIssueNumbers: number[] = [];

          for (const title of subIssueTitles) {
            const subNum = await createSubIssue(repo, issueNumber, title, token);
            if (subNum) {
              subIssueNumbers.push(subNum);
            }
          }

          // Label sub-issues as agent if they have credentials
          for (const subNum of subIssueNumbers) {
            await addLabel(repo, subNum, "agent", token);
          }

          // Label parent as too-large and post comment
          await addLabel(repo, issueNumber, "scope:large", token);
          const subIssueLinks = subIssueNumbers
            .map(n => `#${n}`)
            .join(", ");
          await postTriageComment(
            repo,
            issueNumber,
            `🔀 **Auto-triaged**: Broke down this ${criteria}-criteria issue into ${subIssueNumbers.length} sub-issues:\n\n${subIssueLinks}\n\nEach sub-issue is now tagged as agent-ready.`,
            token
          );
        } else {
          // Breakdown failed, mark for manual triage
          await addLabel(repo, issueNumber, "needs:triage", token);
          await postTriageComment(
            repo,
            issueNumber,
            `⚠️ **Manual triage needed**: This issue has ${criteria} acceptance criteria (recommended max: ${AGENT_READY_THRESHOLD}).\n\nPlease manually break this into smaller issues.`,
            token
          );
        }
      }
      // Criteria >6 or 0: Manual triage required
      else if (criteria > BREAKDOWN_THRESHOLD || criteria === 0) {
        console.log(
          `Issue #${issueNumber}: ${criteria} acceptance criteria (exceeds triage limit or has no criteria)`
        );

        await addLabel(repo, issueNumber, "needs:triage", token);
        await postTriageComment(
          repo,
          issueNumber,
          criteria === 0
            ? `❓ **Manual triage needed**: This issue doesn't have acceptance criteria.\n\nPlease add checklist items to clarify scope.`
            : `⚠️ **Manual triage needed**: This issue has ${criteria} acceptance criteria (recommended max: ${AGENT_READY_THRESHOLD}).\n\nPlease break this into smaller, focused issues.`,
          token
        );
      }
    }

  } catch (error) {
    console.error(`Error scanning repository ${repo}:`, error);
    // Continue with other repos on error
  }
}

/**
 * Main handler function triggered by EventBridge (every 15 minutes)
 */
export async function handler() {
  console.log("Auto-triage handler triggered");

  try {
    // Get credentials
    const [appId, privateKey, anthropicApiKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      getParameter("/github-agent/ANTHROPIC_API_KEY"),
    ]);

    const appConfig: GitHubAppConfig = {
      appId,
      privateKey,
    };

    // Determine which repos to scan
    const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;

    // Get token for first repo to use across all queries
    const [owner, repoName] = repos[0].split("/");
    const githubToken = await getInstallationToken(owner, repoName, appConfig);

    // Scan each repository
    for (const repo of repos) {
      await scanRepository(repo, githubToken, appConfig, anthropicApiKey);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Auto-triage handler completed",
        repos_scanned: repos.length,
      }),
    };

  } catch (error) {
    console.error("Auto-triage handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
}
