/**
 * Issue Grooming Handler Lambda
 *
 * Scans open issues with 'agent' label and enforces acceptance criteria limits:
 * - Flags issues with >3 acceptance criteria checkboxes
 * - Posts actionable comments suggesting splits
 * - Applies labels for visibility
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

// Monitored repositories for grooming (comma-separated)
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

const AGENT_LABEL = "agent";
const NEEDS_SPLIT_LABEL = "scope:large";
const MAX_ACCEPTANCE_CRITERIA = 3;
const STALE_THRESHOLD_MINUTES = 45;

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
      "User-Agent": "github-agent-grooming",
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
 * Gets the timestamp when the agent:running label was added
 */
async function getAgentRunningLabelTime(
  repo: string,
  issueNumber: number,
  token: string
): Promise<Date | null> {
  try {
    const response = await githubRequest(
      `/repos/${repo}/issues/${issueNumber}/events`,
      token,
      { method: "GET" },
      [200]
    );

    const events = await response.json() as any[];
    const labelEvent = events
      .filter((event: any) =>
        event.event === "labeled" &&
        event.label?.name === "agent:running"
      )
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (!labelEvent) {
      return null;
    }

    return new Date(labelEvent.created_at);
  } catch (error) {
    console.warn(`Failed to get agent:running timestamp for ${repo}#${issueNumber}:`, error);
    return null;
  }
}

/**
 * Posts a comment suggesting the issue be split
 */
async function postSplitSuggestion(
  repo: string,
  issueNumber: number,
  criteria: string,
  token: string
): Promise<void> {
  const body = `⚠️ **Issue Grooming Alert**

${criteria}

**Recommendation:** Consider splitting this into smaller issues with ≤3 acceptance criteria each. Smaller, focused issues have higher success rates with the agent.

The agent works best with one clear thing to do. Multiple independent tasks are better handled as separate issues, which can be cross-linked if needed.`;

  await githubRequest(
    `/repos/${repo}/issues/${issueNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );

  console.log(`Posted split suggestion comment on ${repo}#${issueNumber}`);
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
 * Checks if issue has a comment from this handler already
 */
async function hasGroomingComment(
  repo: string,
  issueNumber: number,
  token: string
): Promise<boolean> {
  try {
    const response = await githubRequest(
      `/repos/${repo}/issues/${issueNumber}/comments`,
      token,
      { method: "GET" },
      [200]
    );

    const comments = await response.json() as any[];
    return comments.some((comment: any) =>
      comment.body.includes("Issue Grooming Alert")
    );
  } catch (error) {
    console.warn(`Failed to check grooming comments for ${repo}#${issueNumber}:`, error);
    return false;
  }
}

/**
 * Scans a single repository for issues needing grooming
 */
async function scanRepository(repo: string, token: string): Promise<void> {
  console.log(`Scanning repository: ${repo}`);

  try {
    // Get all open issues with 'agent' label
    const response = await githubRequest(
      `/repos/${repo}/issues?labels=${AGENT_LABEL}&state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];

    for (const issue of issues) {
      const issueNumber = issue.number;
      const criteria = countAcceptanceCriteria(issue.body);

      // Check for acceptance criteria limit violation
      if (criteria > MAX_ACCEPTANCE_CRITERIA) {
        console.log(
          `Issue #${issueNumber}: ${criteria} acceptance criteria (exceeds max of ${MAX_ACCEPTANCE_CRITERIA})`
        );

        // Skip if we already commented on this issue
        const hasComment = await hasGroomingComment(repo, issueNumber, token);
        if (hasComment) {
          console.log(`Issue #${issueNumber}: Already has grooming comment, skipping`);
          continue;
        }

        // Post comment and add label
        await postSplitSuggestion(
          repo,
          issueNumber,
          `This issue has **${criteria} acceptance criteria** (recommended max: ${MAX_ACCEPTANCE_CRITERIA}).`,
          token
        );

        await addLabel(repo, issueNumber, NEEDS_SPLIT_LABEL, token);
      }

      // Check for stalenesss (agent:running for too long)
      const hasAgentRunning = issue.labels.some((label: any) =>
        label.name === "agent:running"
      );

      if (hasAgentRunning) {
        const runningTime = await getAgentRunningLabelTime(repo, issueNumber, token);
        if (runningTime) {
          const now = new Date();
          const minutesRunning = (now.getTime() - runningTime.getTime()) / (1000 * 60);

          if (minutesRunning > STALE_THRESHOLD_MINUTES) {
            console.log(
              `Issue #${issueNumber}: agent:running for ${minutesRunning.toFixed(0)} minutes (exceeds ${STALE_THRESHOLD_MINUTES})`
            );

            // Post stale marker comment
            const staleBody = `⚠️ **Stale agent marker detected**

This issue has been marked \`agent:running\` for ${minutesRunning.toFixed(0)} minutes. The agent may be stuck. Consider:
1. Removing the \`agent:running\` label to allow retry
2. Checking the CloudWatch logs for errors
3. If the issue is too large, consider splitting it into smaller tasks`;

            await githubRequest(
              `/repos/${repo}/issues/${issueNumber}/comments`,
              token,
              {
                method: "POST",
                body: JSON.stringify({ body: staleBody }),
              },
              [201]
            );

            console.log(`Posted stale marker comment on ${repo}#${issueNumber}`);
          }
        }
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
  console.log("Issue grooming handler triggered");

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
    // (could refactor to get per-repo tokens if needed)
    const githubToken = await getInstallationToken(repos[0].split("/")[0], repos[0].split("/")[1], appConfig);

    // Scan each repository
    for (const repo of repos) {
      await scanRepository(repo, githubToken);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Issue grooming handler completed",
        repos_scanned: repos.length,
      }),
    };

  } catch (error) {
    console.error("Issue grooming handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
}
