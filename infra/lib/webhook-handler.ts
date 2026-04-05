import { createHmac } from "crypto";
import {
  ECSClient,
  RunTaskCommand,
  type RunTaskCommandInput,
} from "@aws-sdk/client-ecs";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  TaskPayload,
  IssueMetadata,
  generateTaskId,
  generateExampleId,
  createRepoSlug,
  createFeedbackExamplePath,
  createFeedbackIndexPath,
  getInstallationToken,
  createInitialTaskMetadata,
  createArtifactKeys,
  type TaskEnvironment,
  type GitHubAppConfig,
  type TaskMetadata,
  type FeedbackExample,
  type FeedbackExampleIndex,
  type CreditBalance,
  type CreditTransaction,
  createCreditBalancePath,
  createCreditLedgerPath,
  getModelCost,
  type EscalationConfig,
  createEscalationConfigPath,
  createEscalationQueuePath,
  PROTECTED_PATHS,
  CODING_AGENT_BOT_LOGINS,
} from "./types";
import { publishDigestToSocialMedia } from "./digest-publisher";

const ecs = new ECSClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const DIAGNOSTIC_TASK_DEFINITION_ARN = process.env.DIAGNOSTIC_TASK_DEFINITION_ARN!;
const CONTAINER_NAME = process.env.CONTAINER_NAME!;
const DIAGNOSTIC_CONTAINER_NAME = process.env.DIAGNOSTIC_CONTAINER_NAME!;
const SUBNETS = process.env.SUBNETS!;
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const OPENROUTER_API_KEY_PARAM = process.env.OPENROUTER_API_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const TRIGGER_LABEL = "agent";
const DIAGNOSE_LABEL = "diagnose";
const QUEUED_LABEL = "agent:queued";
const SIGNAL_LABEL_RUNNING = "agent:running";
const SIGNAL_LABEL_WAITING = "agent:waiting";
const SIGNAL_LABEL_FAILED = "agent:failed";
const SIGNAL_LABEL_SUCCEEDED = "agent:succeeded";
const REVIEW_APPROVED_LABEL = "review:approved";
const BLOCKED_MAIN_BROKEN_LABEL = "blocked:main-broken";

// Auto-merge hold period (1 hour)
const MERGE_HOLD_PERIOD_MINUTES = 60;
const STATUS_BLOCKED_LABEL = "status:blocked";
const SIGNAL_LABELS = [
  {
    name: SIGNAL_LABEL_RUNNING,
    color: "1D76DB",
    description: "Autonomous run is currently in progress",
  },
  {
    name: SIGNAL_LABEL_WAITING,
    color: "FBCA04",
    description: "Autonomous run is waiting for confirmation or clarification",
  },
  {
    name: SIGNAL_LABEL_FAILED,
    color: "D73A4A",
    description: "Autonomous run failed before finishing",
  },
  {
    name: SIGNAL_LABEL_SUCCEEDED,
    color: "0E8A16",
    description: "Autonomous run finished successfully",
  },
  {
    name: STATUS_BLOCKED_LABEL,
    color: "999999",
    description: "Task is blocked (insufficient credits or other blocker)",
  },
  {
    name: QUEUED_LABEL,
    color: "FBCA04",
    description: "Task is queued due to concurrency limit, will dispatch when capacity available",
  },
] as const;

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
      "User-Agent": "github-agent-control-plane",
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

async function ensureSignalLabels(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<void> {
  for (const label of SIGNAL_LABELS) {
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/labels`,
      token,
      {
        method: "POST",
        body: JSON.stringify(label),
      },
      [201, 422]
    );
  }
}

async function deleteLabelIfPresent(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    token,
    { method: "DELETE" },
    [200, 204, 404]
  );
}

async function setSignalLabel(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  const labelsToRemove = [TRIGGER_LABEL, ...SIGNAL_LABELS.map((entry) => entry.name)]
    .filter((candidate) => candidate !== label);

  for (const candidate of labelsToRemove) {
    await deleteLabelIfPresent(repoOwner, repoName, issueNumber, token, candidate);
  }

  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ labels: [label] }),
    },
    [200]
  );
}

async function addIssueComment(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  body: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );
}

async function getIssueLabels(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string
): Promise<string[]> {
  const response = await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}`,
    token,
    { method: "GET" },
    [200]
  );
  const issueData = await response.json() as any;
  return issueData.labels.map((label: any) => label.name);
}

async function getRepoModelConfig(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<string | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/contents/.github/AGENT.md`,
      token,
      { method: "GET" },
      [200, 404]
    );

    if (response.status === 404) {
      return null;
    }

    const content = (await response.json()) as { type?: string; content?: string };
    if (content.type !== "file" || !content.content) {
      return null;
    }

    // Decode base64 content
    const decoded = Buffer.from(content.content, "base64").toString("utf8");

    // Simple regex to extract model line: "model: anthropic/claude-sonnet-4"
    const modelMatch = decoded.match(/^model:\s*(.+)$/m);
    return modelMatch ? modelMatch[1].trim() : null;
  } catch (error) {
    console.log(`Failed to fetch .github/AGENT.md: ${error}`);
    return null;
  }
}

function getDefaultModel(taskMode: "issue" | "pull_request" | "planning"): string {
  // Use latest 4.6 models per comment in issue #29
  if (taskMode === "planning") {
    return "anthropic/claude-haiku-4-5";
  }
  return taskMode === "issue"
    ? "anthropic/claude-haiku-4-5"
    : "anthropic/claude-sonnet-4-6";
}

async function mergePullRequest(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string,
  holdPeriodMinutes: number
): Promise<boolean> {
  try {
    // First check if PR is still open and approved
    const prResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      token,
      { method: "GET" },
      [200]
    );

    const prData = await prResponse.json() as any;

    if (prData.state !== "open") {
      console.log(`PR ${prNumber} is not open (state: ${prData.state})`);
      return false;
    }

    // Check if it still has the approved label
    const hasApprovedLabel = prData.labels.some((label: any) => label.name === REVIEW_APPROVED_LABEL);
    if (!hasApprovedLabel) {
      console.log(`PR ${prNumber} no longer has the ${REVIEW_APPROVED_LABEL} label`);
      return false;
    }

    // Check if there's a pause-agent label
    const hasPauseLabel = prData.labels.some((label: any) => label.name === "pause-agent");
    if (hasPauseLabel) {
      console.log(`PR ${prNumber} has pause-agent label, skipping merge`);
      return false;
    }

    console.log(`Attempting to merge PR ${prNumber}`);

    // Attempt the merge
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/merge`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({
          commit_title: `Merge pull request #${prNumber} from ${prData.head.ref}`,
          commit_message: `Automatically merged by review agent after ${holdPeriodMinutes}-minute hold period.`,
          merge_method: "merge"
        }),
      },
      [200]
    );

    // Add a comment about the auto-merge
    await addIssueComment(
      repoOwner,
      repoName,
      prNumber,
      token,
      `🤖 **Automatically merged** after ${holdPeriodMinutes}-minute hold period.

This PR was approved by the automated review agent and no human intervention occurred during the hold period.`
    );

    console.log(`Successfully merged PR ${prNumber}`);
    return true;

  } catch (error) {
    console.error(`Failed to merge PR ${prNumber}:`, error);

    // Add a comment about the merge failure
    await addIssueComment(
      repoOwner,
      repoName,
      prNumber,
      token,
      `❌ **Auto-merge failed**

The automated merge failed after the ${holdPeriodMinutes}-minute hold period. Manual intervention required.

Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );

    return false;
  }
}

async function scheduleAutoMerge(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string,
  holdPeriodMinutes: number
): Promise<void> {
  // The actual auto-merge is handled by the review handler Lambda which runs every 15 minutes
  // This function just posts an informational comment about the scheduled merge

  const mergeTime = new Date(Date.now() + holdPeriodMinutes * 60 * 1000);
  const messageBody = `⏱️ **Auto-merge scheduled**

This PR is approved and will be automatically merged at **${mergeTime.toISOString()}** (in ${holdPeriodMinutes} minutes) unless:

- The \`${REVIEW_APPROVED_LABEL}\` label is removed
- A \`pause-agent\` label is added
- The PR is closed manually
- Someone pushes new commits

To prevent auto-merge, remove the \`${REVIEW_APPROVED_LABEL}\` label or add the \`pause-agent\` label.`;

  await addIssueComment(repoOwner, repoName, prNumber, token, messageBody);

  console.log(`Auto-merge scheduled for PR ${prNumber} at ${mergeTime.toISOString()} (${holdPeriodMinutes} minute hold period)`);
}

async function lookupTaskMetadataForPR(
  repoSlug: string,
  prNumber: number
): Promise<TaskMetadata | null> {
  try {
    // Search for task metadata that references this PR
    // Path pattern: tasks/{repoSlug}/**/metadata.json
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACTS_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    if (!listResult.Contents) {
      return null;
    }

    // Search through metadata files for one that matches this PR
    const metadataKeys = listResult.Contents
      .filter((obj: any) => obj.Key?.endsWith('/metadata.json'))
      .map((obj: any) => obj.Key!);

    for (const metadataKey of metadataKeys) {
      const result = await s3.send(new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: metadataKey,
      }));

      if (!result.Body) continue;

      try {
        const content = await result.Body.transformToString() as string;
        const metadata = JSON.parse(content) as TaskMetadata;

        // Check if this task created the PR we're looking at
        if (metadata.task_mode === "pull_request" &&
            metadata.issue_number === prNumber &&
            metadata.status === "succeeded") {
          return metadata;
        }
      } catch {
        // Skip malformed metadata files
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to lookup task metadata for PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Finds the PR created by a succeeded issue task by looking at issue timeline
 */
async function findPRCreatedBySucceededTask(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string
): Promise<{ pr_number: number; pr_url: string } | null> {
  try {
    // Get issue timeline to find cross-references to PRs
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/timeline?per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const timeline = await response.json() as any[];

    // Look for cross-referenced events with PR links
    for (const event of timeline) {
      if (event.event === "cross-referenced" &&
          event.source?.issue?.pull_request?.html_url) {
        const prUrl = event.source.issue.pull_request.html_url;
        const prNumber = parseInt(prUrl.split("/").pop(), 10);

        console.log(`Found PR #${prNumber} created by issue #${issueNumber}`);
        return { pr_number: prNumber, pr_url: prUrl };
      }
    }

    console.log(`No PR found in timeline for issue #${issueNumber}`);
    return null;
  } catch (error) {
    console.error(`Failed to find PR for issue #${issueNumber}:`, error);
    return null;
  }
}

/**
 * Discovers and launches reviews for any unreviewed bot PRs in the repo.
 * Called before launching new agent tasks to prioritize reviews over new work.
 */
async function reviewPendingBotPRs(
  repoOwner: string,
  repoName: string,
  token: string,
  openrouterKey: string
): Promise<number> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const prs = await response.json() as any[];

    const needsReview = prs.filter((pr: any) => {
      const isBotPR = CODING_AGENT_BOT_LOGINS.some(
        login => pr.user.login === login || pr.user.login.includes(login.replace("[bot]", ""))
      );
      const hasReviewLabel = pr.labels.some((label: any) =>
        label.name.startsWith("review:")
      );
      const hasPauseLabel = pr.labels.some((label: any) =>
        label.name === "pause-agent"
      );
      return isBotPR && !hasReviewLabel && !hasPauseLabel;
    });

    if (needsReview.length === 0) {
      return 0;
    }

    console.log(`Found ${needsReview.length} unreviewed bot PR(s) in ${repoOwner}/${repoName}, launching reviews first`);

    let reviewsTriggered = 0;
    for (const pr of needsReview) {
      const taskArn = await triggerReviewForPR(repoOwner, repoName, pr.number, token, openrouterKey);
      if (taskArn) {
        reviewsTriggered++;
        console.log(`Triggered priority review for PR #${pr.number}`);
      }
    }

    return reviewsTriggered;
  } catch (error) {
    console.error(`Failed to check for pending reviews:`, error);
    return 0;
  }
}

/**
 * Triggers a review task for a specific PR
 */
async function triggerReviewForPR(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string,
  openrouterKey: string
): Promise<string | null> {
  try {
    // Fetch PR details
    const prResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      token,
      { method: "GET" },
      [200]
    );

    const pr = await prResponse.json() as any;
    const repoSlug = createRepoSlug(repoOwner, repoName);
    const taskId = generateTaskId();
    const artifactPrefix = `tasks/${repoSlug}/${taskId}`;

    // Create review payload (mirrors review-handler.ts pattern)
    const reviewPayload = {
      task_id: taskId,
      repo_slug: repoSlug,
      pr_number: prNumber,
      head_sha: pr.head.sha,
      base_sha: pr.base.sha,
      pr_metadata: {
        number: prNumber,
        title: pr.title,
        body: pr.body || "",
        labels: pr.labels.map((label: any) => label.name),
        author: pr.user.login,
        head_ref: pr.head.ref,
        base_ref: pr.base.ref,
        created_by_bot: true,
      },
      created_at: new Date().toISOString(),
    };

    const reviewCriteria = {
      check_compilation: true,
      check_security: true,
      check_issue_alignment: true,
      check_logic: true,
      check_complexity: true,
      check_cost_impact: true,
      protected_paths: PROTECTED_PATHS,
    };

    const reviewEnvironment: Record<string, string> = {
      REVIEW_PAYLOAD: JSON.stringify(reviewPayload),
      GITHUB_TOKEN: token,
      OPENROUTER_API_KEY: openrouterKey,
      ARTIFACTS_BUCKET,
      ARTIFACT_PREFIX: artifactPrefix,
      REPO: repoSlug,
      PR_NUMBER: prNumber.toString(),
      REVIEW_CRITERIA: JSON.stringify(reviewCriteria),
    };

    // Get environment variables for ECS task
    const REVIEW_TASK_DEFINITION_ARN = process.env.REVIEW_TASK_DEFINITION_ARN!;
    const REVIEW_CONTAINER_NAME = process.env.REVIEW_CONTAINER_NAME!;

    const params: RunTaskCommandInput = {
      cluster: CLUSTER_ARN,
      taskDefinition: REVIEW_TASK_DEFINITION_ARN,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS.split(","),
          securityGroups: [SECURITY_GROUP],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: REVIEW_CONTAINER_NAME,
            environment: Object.entries(reviewEnvironment).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
    };

    const result = await ecs.send(new RunTaskCommand(params));
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn || (result.failures?.length ?? 0) > 0) {
      const failureDetails =
        result.failures?.map((failure) => failure.reason ?? failure.arn ?? "unknown failure") ??
        [];
      throw new Error(
        failureDetails.length > 0
          ? `Review task launch failed: ${failureDetails.join(", ")}`
          : "Review task launch did not return a task ARN"
      );
    }

    console.log(`Triggered review task ${taskId} for PR #${prNumber} (${taskArn})`);

    // Store initial review metadata
    const metadata = {
      task_id: taskId,
      pr_number: prNumber,
      repo_slug: repoSlug,
      status: "running",
      task_arn: taskArn,
      created_at: reviewPayload.created_at,
      started_at: new Date().toISOString(),
    };

    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: `${artifactPrefix}/review-metadata.json`,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json",
    }));

    console.log(`Stored review metadata at ${artifactPrefix}/review-metadata.json`);
    return taskArn;
  } catch (error) {
    console.error(`Failed to trigger review for PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Gets the CI check status for a PR
 * Returns { conclusion, failures } where conclusion is "success", "failure", etc., and failures is list of failed checks
 */
async function getPRCheckStatus(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string
): Promise<{ conclusion: string; failures: string[] } | null> {
  try {
    // Get PR details to find the head SHA
    const prResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      token,
      { method: "GET" },
      [200]
    );

    const pr = await prResponse.json() as any;
    const headSha = pr.head.sha;

    // Get combined check status for the commit
    const statusResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/commits/${headSha}/status`,
      token,
      { method: "GET" },
      [200]
    );

    const statusData = await statusResponse.json() as any;
    const conclusion = statusData.state; // "success", "failure", "pending", "error"

    // Extract failed check names
    const failures = statusData.statuses
      .filter((status: any) => status.state === "failure" || status.state === "error")
      .map((status: any) => status.context);

    return { conclusion, failures };
  } catch (error) {
    console.error(`Failed to get PR check status for #${prNumber}:`, error);
    return null;
  }
}

/**
 * Checks if the main branch CI is healthy
 * Returns true if main's checks are all passing, false otherwise
 */
async function getMainCIHealth(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<boolean> {
  try {
    // Get the default branch (usually main) commit SHA
    const repoResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}`,
      token,
      { method: "GET" },
      [200]
    );

    const repoData = await repoResponse.json() as any;
    const defaultBranch = repoData.default_branch;

    // Get the latest commit on the default branch
    const branchResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/branches/${defaultBranch}`,
      token,
      { method: "GET" },
      [200]
    );

    const branchData = await branchResponse.json() as any;
    const mainSha = branchData.commit.sha;

    // Get combined check status for main
    const statusResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/commits/${mainSha}/status`,
      token,
      { method: "GET" },
      [200]
    );

    const statusData = await statusResponse.json() as any;
    return statusData.state === "success";
  } catch (error) {
    console.error(`Failed to check main CI health for ${repoOwner}/${repoName}:`, error);
    return true; // Assume healthy on error to avoid false negatives
  }
}

/**
 * Checks if a task should be allowed to dispatch despite main CI being broken
 * Allows: issues with type:bug, priority:high labels, or titles with "fix:" or "CI"
 * Blocks: everything else (feature work, enhancements, etc.)
 */
function isAllowedDespiteMainBroken(
  issueTitle: string,
  labels: string[],
  taskMode: "issue" | "pull_request" | "planning"
): boolean {
  // PRs are not blocked (they're being reviewed, not creating new work)
  if (taskMode === "pull_request") {
    return true;
  }

  // Check for explicit bug/critical labels
  const allowedLabels = new Set(["type:bug", "priority:high", "emergency", "hotfix"]);
  if (labels.some(label => allowedLabels.has(label.toLowerCase()))) {
    return true;
  }

  // Check title for fix/CI keywords
  const titleLower = issueTitle.toLowerCase();
  if (titleLower.includes("fix:") || titleLower.includes("ci:") || titleLower.includes("ci ")) {
    return true;
  }

  return false;
}

/**
 * Unblocks issues that were blocked due to main CI being broken
 * Called when main branch CI goes green - re-adds agent label to trigger dispatch
 */
async function unblockMainBrokenIssues(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<number> {
  try {
    // List all open issues with the blocked:main-broken label
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&labels=${encodeURIComponent(BLOCKED_MAIN_BROKEN_LABEL)}&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];
    console.log(`Found ${issues.length} open issue(s) with blocked:main-broken label`);

    let unblockedCount = 0;

    for (const issue of issues) {
      const issueNumber = issue.number;

      console.log(`Unblocking issue #${issueNumber}: ${issue.title}`);

      // Remove the blocked:main-broken label
      await deleteLabelIfPresent(repoOwner, repoName, issueNumber, token, BLOCKED_MAIN_BROKEN_LABEL);

      // Add the agent trigger label
      await githubRequest(
        `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ labels: [TRIGGER_LABEL] }),
        },
        [200]
      );

      // Post unblocking comment
      await addIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        token,
        `🎉 **Unblocked — Main branch CI is now healthy!**

The main branch CI is now passing. This issue is no longer blocked and has been re-labeled with \`${TRIGGER_LABEL}\` for dispatch.

The agent will process this on the next available cycle.`
      );

      unblockedCount++;
    }

    console.log(`Unblocked ${unblockedCount} issue(s)`);
    return unblockedCount;
  } catch (error) {
    console.error(`Failed to unblock main-broken issues: ${error}`);
    return 0;
  }
}

/**
 * Parses PR body for issue references like "Fixes #123" or "Closes owner/repo#123"
 * Returns array of { issue_number, repo_owner, repo_name } for cross-repo refs
 */
function parseIssueReferences(prBody: string, prRepoOwner: string): Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> {
  if (!prBody) return [];

  const references: Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> = [];

  // Match patterns like "Fixes #123", "Closes #456", "Resolves owner/repo#789"
  const patterns = [
    /(?:Fixes|Closes|Resolves)\s+#(\d+)/gi,  // Same repo: Fixes #123
    /(?:Fixes|Closes|Resolves)\s+([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/gi,  // Cross-repo: Fixes owner/repo#123
  ];

  // Match same-repo references
  const sameRepoMatches = prBody.matchAll(/(?:Fixes|Closes|Resolves)\s+#(\d+)/gi);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: prRepoOwner,
      repo_name: "",  // Will be filled from PR context
      is_same_repo: true,
    });
  }

  // Match cross-repo references
  const crossRepoMatches = prBody.matchAll(/(?:Fixes|Closes|Resolves)\s+([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/gi);
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
      is_same_repo: false,
    });
  }

  return references;
}

/**
 * Parses issue body for blocker references like "Blocked by #123" or "Blocked by owner/repo#123"
 * Returns array of { issue_number, repo_owner, repo_name, is_same_repo }
 */
function parseBlockerReferences(issueBody: string, issueRepoOwner: string): Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> {
  if (!issueBody) return [];

  const references: Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> = [];

  // Match same-repo references: "Blocked by #123"
  const sameRepoMatches = issueBody.matchAll(/(?:Blocked by)\s+#(\d+)/gi);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: issueRepoOwner,
      repo_name: "",
      is_same_repo: true,
    });
  }

  // Match cross-repo references: "Blocked by owner/repo#123"
  const crossRepoMatches = issueBody.matchAll(/(?:Blocked by)\s+([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/gi);
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
      is_same_repo: false,
    });
  }

  return references;
}

/**
 * Parses issue body for task chaining dependencies like "depends_on: #98, #99" or "depends_on: owner/repo#98"
 * Returns array of { issue_number, repo_owner, repo_name, is_same_repo }
 */
function parseDependsOn(issueBody: string, issueRepoOwner: string): Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> {
  if (!issueBody) return [];

  const references: Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> = [];

  // Find the depends_on line: "depends_on: #123, #456" or "depends_on: owner/repo#123"
  const dependsOnMatch = issueBody.match(/^depends_on:\s*(.+)$/m);
  if (!dependsOnMatch) return [];

  const dependsOnStr = dependsOnMatch[1];

  // Match same-repo references: #123
  const sameRepoMatches = dependsOnStr.matchAll(/#(\d+)/g);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: issueRepoOwner,
      repo_name: "",
      is_same_repo: true,
    });
  }

  // Match cross-repo references: owner/repo#123
  const crossRepoMatches = dependsOnStr.matchAll(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/g);
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
      is_same_repo: false,
    });
  }

  return references;
}

/**
 * Parses issue body for follow-up chaining like "then: #101, #102" or "then: owner/repo#101"
 * Returns array of { issue_number, repo_owner, repo_name, is_same_repo }
 */
function parseThen(issueBody: string, issueRepoOwner: string): Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> {
  if (!issueBody) return [];

  const references: Array<{ issue_number: number; repo_owner: string; repo_name: string; is_same_repo: boolean }> = [];

  // Find the then line: "then: #101, #102" or "then: owner/repo#101"
  const thenMatch = issueBody.match(/^then:\s*(.+)$/m);
  if (!thenMatch) return [];

  const thenStr = thenMatch[1];

  // Match same-repo references: #123
  const sameRepoMatches = thenStr.matchAll(/#(\d+)/g);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: issueRepoOwner,
      repo_name: "",
      is_same_repo: true,
    });
  }

  // Match cross-repo references: owner/repo#123
  const crossRepoMatches = thenStr.matchAll(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/g);
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
      is_same_repo: false,
    });
  }

  return references;
}

/**
 * Checks if all dependencies for an issue are satisfied (merged/closed)
 */
async function areAllDependenciesSatisfied(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  issueBody: string,
  token: string
): Promise<boolean> {
  const dependencies = parseDependsOn(issueBody, repoOwner);

  if (dependencies.length === 0) {
    return true; // No dependencies means satisfied
  }

  for (const dep of dependencies) {
    try {
      const response = await githubRequest(
        `/repos/${dep.repo_owner}/${dep.repo_name || repoName}/issues/${dep.issue_number}`,
        token,
        { method: "GET" },
        [200]
      );
      const depIssueData = await response.json() as any;

      // If dependency is still open, not all deps are satisfied
      if (depIssueData.state === "open") {
        console.log(
          `Issue #${issueNumber} dependency ${dep.repo_owner}/${dep.repo_name || repoName}#${dep.issue_number} is still open`
        );
        return false;
      }
    } catch (error) {
      console.log(`Failed to check dependency ${dep.repo_owner}/${dep.repo_name || repoName}#${dep.issue_number}: ${error}`);
      return false;
    }
  }

  return true;
}

/**
 * Checks for circular dependencies to prevent infinite loops
 */
function detectCircularDependency(
  issueNumber: number,
  issueBody: string,
  issueRepoOwner: string,
  visited: Set<string> = new Set()
): boolean {
  const currentKey = `${issueRepoOwner}#${issueNumber}`;

  if (visited.has(currentKey)) {
    return true; // Circular dependency detected
  }

  visited.add(currentKey);
  const dependencies = parseDependsOn(issueBody, issueRepoOwner);

  for (const dep of dependencies) {
    const depKey = `${dep.repo_owner}#${dep.issue_number}`;
    if (visited.has(depKey)) {
      return true;
    }
  }

  return false;
}

/**
 * Configuration for issue dispatch (read from .github/AGENT.md)
 */
interface DispatchConfig {
  auto_dispatch: boolean;
  auto_dispatch_labels: string[];
  wip_cap: number;
  max_concurrent: number;
}

/**
 * Configuration for merge hold period (read from .github/AGENT.md)
 */
interface MergeHoldConfig {
  merge_hold_minutes: number;
  merge_hold_minutes_infra: number;
}

/**
 * Reads dispatch configuration from repo's .github/AGENT.md
 * Returns config with defaults if file doesn't exist
 */
async function getDispatchConfig(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<DispatchConfig> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/contents/.github/AGENT.md`,
      token,
      { method: "GET" },
      [200, 404]
    );

    if (response.status === 404) {
      return { auto_dispatch: true, auto_dispatch_labels: ["ready"], wip_cap: 0, max_concurrent: 3 };
    }

    const content = await response.json() as any;
    if (content.type !== "file" || !content.content) {
      return { auto_dispatch: true, auto_dispatch_labels: ["ready"], wip_cap: 0, max_concurrent: 3 };
    }

    // Decode base64 content
    const decoded = Buffer.from(content.content as string, "base64").toString("utf8");

    // Extract configuration lines
    const autoDispatchMatch = decoded.match(/^auto_dispatch:\s*(.+)$/m);
    const labelsMatch = decoded.match(/^auto_dispatch_labels:\s*(.+)$/m);
    const wipCapMatch = decoded.match(/^wip_cap:\s*(\d+)$/m);
    const maxConcurrentMatch = decoded.match(/^max_concurrent:\s*(\d+)$/m);

    const auto_dispatch = autoDispatchMatch ? autoDispatchMatch[1].trim().toLowerCase() === "true" : true;
    const auto_dispatch_labels = labelsMatch
      ? labelsMatch[1].trim().split(",").map(l => l.trim()).filter(l => l)
      : ["ready"];
    const wip_cap = wipCapMatch ? parseInt(wipCapMatch[1], 10) : 0;
    const max_concurrent = maxConcurrentMatch ? parseInt(maxConcurrentMatch[1], 10) : 3;

    return { auto_dispatch, auto_dispatch_labels, wip_cap, max_concurrent };
  } catch (error) {
    console.log(`Failed to fetch dispatch config from .github/AGENT.md: ${error}`);
    return { auto_dispatch: true, auto_dispatch_labels: ["ready"], wip_cap: 0, max_concurrent: 3 };
  }
}

/**
 * Reads merge hold configuration from repo's .github/AGENT.md
 * Priority order:
 * 1. fast-track label → 5 minutes
 * 2. PR touches infra/ paths → merge_hold_minutes_infra (default: 120)
 * 3. merge_hold_minutes (default: 60)
 */
async function getMergeHoldConfig(
  repoOwner: string,
  repoName: string,
  token: string,
  prNumber: number
): Promise<number> {
  try {
    // Check for fast-track label first
    const prResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      token,
      { method: "GET" },
      [200]
    );

    const prData = await prResponse.json() as any;
    const hasFastTrackLabel = prData.labels.some((label: any) => label.name.toLowerCase() === "fast-track");
    if (hasFastTrackLabel) {
      console.log(`PR #${prNumber} has fast-track label, using 5 minute hold period`);
      return 5;
    }

    // Get .github/AGENT.md config
    const configResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/contents/.github/AGENT.md`,
      token,
      { method: "GET" },
      [200, 404]
    );

    let mergeHoldMinutes = 60; // default
    let mergeHoldMinutesInfra = 120; // default for infra paths

    if (configResponse.status === 200) {
      const content = await configResponse.json() as any;
      if (content.type === "file" && content.content) {
        const decoded = Buffer.from(content.content as string, "base64").toString("utf8");

        const holdMatch = decoded.match(/^merge_hold_minutes:\s*(\d+)$/m);
        if (holdMatch) {
          mergeHoldMinutes = parseInt(holdMatch[1], 10);
        }

        const holdInfraMatch = decoded.match(/^merge_hold_minutes_infra:\s*(\d+)$/m);
        if (holdInfraMatch) {
          mergeHoldMinutesInfra = parseInt(holdInfraMatch[1], 10);
        }
      }
    }

    // Check if PR touches infra/ paths
    const filesResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files?per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const filesData = await filesResponse.json() as any[];
    const touchesInfra = filesData.some((file: any) => file.filename.startsWith("infra/"));

    if (touchesInfra) {
      console.log(`PR #${prNumber} touches infra/ paths, using ${mergeHoldMinutesInfra} minute hold period`);
      return mergeHoldMinutesInfra;
    }

    console.log(`PR #${prNumber} using default ${mergeHoldMinutes} minute hold period`);
    return mergeHoldMinutes;
  } catch (error) {
    console.log(`Failed to fetch merge hold config, using default 60 minutes: ${error}`);
    return 60;
  }
}

/**
 * Checks if an issue body contains acceptance criteria (checklist items)
 */
function hasAcceptanceCriteria(issueBody: string): boolean {
  if (!issueBody) return false;
  // Check for markdown checkbox pattern: - [ ] or - [x]
  return /- \[[ xX]\]/m.test(issueBody);
}

/**
 * Scans open issues for blockers that match the closed issue
 * and dispatches unblocked issues if conditions are met
 */
async function handleBlockerUnblock(
  repoOwner: string,
  repoName: string,
  closedIssueNumber: number,
  token: string
): Promise<void> {
  try {
    const repoSlug = createRepoSlug(repoOwner, repoName);

    // Get dispatch configuration
    const config = await getDispatchConfig(repoOwner, repoName, token);

    // Fetch open issues
    const listIssuesResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const openIssues = await listIssuesResponse.json() as any[];
    console.log(`Found ${openIssues.length} open issues, scanning for blockers of #${closedIssueNumber}`);

    let unblockedCount = 0;
    let dispatchedCount = 0;

    for (const issue of openIssues) {
      // Skip PRs (they have pull_request field)
      if (issue.pull_request) continue;

      const issueNumber = issue.number;
      const issueBody = issue.body || "";
      const issueLabels = issue.labels.map((l: any) => l.name);

      // Check if this issue is blocked by the closed issue
      const blockerReferences = parseBlockerReferences(issueBody, repoOwner);
      const isBlockedByClosed = blockerReferences.some(
        ref => ref.issue_number === closedIssueNumber && ref.is_same_repo
      );

      if (!isBlockedByClosed) continue;

      unblockedCount++;
      console.log(`Issue #${issueNumber} is unblocked by #${closedIssueNumber}`);

      // Post unblocked notification comment
      const unblockedComment = `🎉 **Unblocked** — Issue #${closedIssueNumber} is resolved!\n\nThis issue is now eligible for dispatch.`;
      await addIssueComment(repoOwner, repoName, issueNumber, token, unblockedComment);

      // Check if we should auto-dispatch
      if (!config.auto_dispatch) {
        console.log(`Issue #${issueNumber}: auto_dispatch disabled, skipping dispatch`);
        continue;
      }

      // Check for required labels
      const hasRequiredLabels = config.auto_dispatch_labels.length === 0 ||
        config.auto_dispatch_labels.some(label => issueLabels.includes(label));

      if (!hasRequiredLabels) {
        console.log(
          `Issue #${issueNumber}: missing required labels (need one of: ${config.auto_dispatch_labels.join(", ")}), skipping dispatch`
        );
        continue;
      }

      // Check for acceptance criteria
      if (!hasAcceptanceCriteria(issueBody)) {
        console.log(`Issue #${issueNumber}: missing acceptance criteria, skipping dispatch`);
        continue;
      }

      // Check WIP cap if configured
      if (config.wip_cap > 0) {
        // Count issues with agent:running label
        const listRunningResponse = await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues?state=open&labels=${encodeURIComponent(SIGNAL_LABEL_RUNNING)}&per_page=100`,
          token,
          { method: "GET" },
          [200]
        );
        const runningIssues = await listRunningResponse.json() as any[];
        const runningCount = runningIssues.length;

        if (runningCount >= config.wip_cap) {
          const wipMessage = `ℹ️ **Dispatch queued** — WIP cap reached (${runningCount}/${config.wip_cap})\n\nThis issue will be dispatched when capacity becomes available.`;
          await addIssueComment(repoOwner, repoName, issueNumber, token, wipMessage);
          console.log(
            `Issue #${issueNumber}: WIP cap reached (${runningCount}/${config.wip_cap}), skipping dispatch for now`
          );
          continue;
        }
      }

      // All checks passed, add agent label
      console.log(`Dispatching issue #${issueNumber}`);
      await githubRequest(
        `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ labels: [TRIGGER_LABEL] }),
        },
        [200]
      );
      dispatchedCount++;
    }

    console.log(
      `Blocker scan complete for #${closedIssueNumber}: found ${unblockedCount} unblocked issue(s), dispatched ${dispatchedCount}`
    );
  } catch (error) {
    console.error(`Error during blocker unblock handling:`, error);
    // Don't throw - this is a side effect, shouldn't block PR merge
  }
}

/**
 * Handles task chaining: when a PR merges, dispatch follow-up issues listed in "then:"
 * if all their dependencies are satisfied
 */
async function handleTaskChainingOnMerge(
  repoOwner: string,
  repoName: string,
  mergedPrNumber: number,
  prBody: string,
  token: string
): Promise<void> {
  try {
    // Parse "then:" syntax from PR body
    const followUpIssues = parseThen(prBody, repoOwner);

    if (followUpIssues.length === 0) {
      console.log(`No follow-up issues found in PR #${mergedPrNumber}`);
      return;
    }

    console.log(`Found ${followUpIssues.length} follow-up issue(s) in PR #${mergedPrNumber}`);

    for (const followUp of followUpIssues) {
      const targetRepoName = followUp.repo_name || repoName;
      const targetRepoOwner = followUp.repo_owner;

      try {
        // Fetch the follow-up issue to get its body
        const response = await githubRequest(
          `/repos/${targetRepoOwner}/${targetRepoName}/issues/${followUp.issue_number}`,
          token,
          { method: "GET" },
          [200, 404]
        );

        if (response.status === 404) {
          console.log(
            `Follow-up issue ${targetRepoOwner}/${targetRepoName}#${followUp.issue_number} not found`
          );
          continue;
        }

        const followUpData = await response.json() as any;
        const followUpBody = followUpData.body || "";

        // Check if all dependencies of the follow-up issue are satisfied
        const allDepsSatisfied = await areAllDependenciesSatisfied(
          targetRepoOwner,
          targetRepoName,
          followUp.issue_number,
          followUpBody,
          token
        );

        if (!allDepsSatisfied) {
          console.log(
            `Follow-up issue #${followUp.issue_number} has unsatisfied dependencies, skipping dispatch`
          );
          continue;
        }

        // Check for circular dependencies
        if (detectCircularDependency(followUp.issue_number, followUpBody, targetRepoOwner)) {
          console.log(
            `Circular dependency detected for follow-up issue #${followUp.issue_number}, skipping dispatch`
          );
          await addIssueComment(
            targetRepoOwner,
            targetRepoName,
            followUp.issue_number,
            token,
            `⚠️ **Circular Dependency Detected**\n\nThis issue has circular dependencies and cannot be dispatched automatically. Please review the \`depends_on:\` and \`then:\` references.`
          );
          continue;
        }

        // Dispatch the follow-up issue
        console.log(`Dispatching follow-up issue #${followUp.issue_number}`);
        await githubRequest(
          `/repos/${targetRepoOwner}/${targetRepoName}/issues/${followUp.issue_number}/labels`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ labels: [TRIGGER_LABEL] }),
          },
          [200]
        );

        // Post comment on follow-up issue
        const followUpComment = `✅ **Dependencies Satisfied** — PR #${mergedPrNumber} in ${repoOwner}/${repoName} merged!\n\nAll dependencies for this issue are now met and it has been queued for dispatch.`;
        await addIssueComment(
          targetRepoOwner,
          targetRepoName,
          followUp.issue_number,
          token,
          followUpComment
        );
      } catch (error) {
        console.error(
          `Failed to dispatch follow-up issue #${followUp.issue_number}: ${error}`
        );
      }
    }

    console.log(`Task chaining complete for merged PR #${mergedPrNumber}`);
  } catch (error) {
    console.error(`Error during task chaining on merge:`, error);
    // Don't throw - this is a side effect, shouldn't block PR merge
  }
}

/**
 * Handles task chaining when an issue closes: dispatch issues that depend on this one
 * using the "depends_on:" syntax, if all their dependencies are now met
 */
async function handleTaskChainingOnIssueClose(
  repoOwner: string,
  repoName: string,
  closedIssueNumber: number,
  token: string
): Promise<void> {
  try {
    const repoSlug = createRepoSlug(repoOwner, repoName);
    const config = await getDispatchConfig(repoOwner, repoName, token);

    // Fetch open issues
    const listIssuesResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const openIssues = await listIssuesResponse.json() as any[];
    console.log(`Scanning ${openIssues.length} open issues for depends_on references to #${closedIssueNumber}`);

    let checkedCount = 0;
    let dispatchedCount = 0;

    for (const issue of openIssues) {
      // Skip PRs (they have pull_request field)
      if (issue.pull_request) continue;

      const issueNumber = issue.number;
      const issueBody = issue.body || "";
      const issueLabels = issue.labels.map((l: any) => l.name);

      // Check if this issue has a depends_on reference that includes the closed issue
      const dependencies = parseDependsOn(issueBody, repoOwner);
      const dependsOnClosed = dependencies.some(
        ref => ref.issue_number === closedIssueNumber && ref.is_same_repo
      );

      if (!dependsOnClosed) continue;

      checkedCount++;
      console.log(`Issue #${issueNumber} depends on closed issue #${closedIssueNumber}`);

      // Check if all dependencies are now satisfied
      const allDepsSatisfied = await areAllDependenciesSatisfied(
        repoOwner,
        repoName,
        issueNumber,
        issueBody,
        token
      );

      if (!allDepsSatisfied) {
        console.log(`Issue #${issueNumber} still has unsatisfied dependencies, skipping dispatch`);
        const pendingComment = `ℹ️ **Dependency Progress** — Issue #${closedIssueNumber} is resolved.\n\nOther dependencies still pending. This issue will be dispatched once all dependencies are met.`;
        await addIssueComment(repoOwner, repoName, issueNumber, token, pendingComment);
        continue;
      }

      // Post notification comment
      const satisfiedComment = `🎉 **All Dependencies Satisfied** — Issue #${closedIssueNumber} is resolved!\n\nAll dependencies for this issue are now met and it has been queued for dispatch.`;
      await addIssueComment(repoOwner, repoName, issueNumber, token, satisfiedComment);

      // Check if we should auto-dispatch
      if (!config.auto_dispatch) {
        console.log(`Issue #${issueNumber}: auto_dispatch disabled, skipping dispatch`);
        continue;
      }

      // Check for required labels
      const hasRequiredLabels = config.auto_dispatch_labels.length === 0 ||
        config.auto_dispatch_labels.some(label => issueLabels.includes(label));

      if (!hasRequiredLabels) {
        console.log(
          `Issue #${issueNumber}: missing required labels (need one of: ${config.auto_dispatch_labels.join(", ")}), skipping dispatch`
        );
        continue;
      }

      // Check for acceptance criteria
      if (!hasAcceptanceCriteria(issueBody)) {
        console.log(`Issue #${issueNumber}: missing acceptance criteria, skipping dispatch`);
        continue;
      }

      // Check WIP cap if configured
      if (config.wip_cap > 0) {
        const listRunningResponse = await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues?state=open&labels=${encodeURIComponent(SIGNAL_LABEL_RUNNING)}&per_page=100`,
          token,
          { method: "GET" },
          [200]
        );
        const runningIssues = await listRunningResponse.json() as any[];
        const runningCount = runningIssues.length;

        if (runningCount >= config.wip_cap) {
          const wipMessage = `ℹ️ **Dispatch queued** — WIP cap reached (${runningCount}/${config.wip_cap})\n\nThis issue will be dispatched when capacity becomes available.`;
          await addIssueComment(repoOwner, repoName, issueNumber, token, wipMessage);
          console.log(
            `Issue #${issueNumber}: WIP cap reached (${runningCount}/${config.wip_cap}), skipping dispatch for now`
          );
          continue;
        }
      }

      // Check for circular dependencies
      if (detectCircularDependency(issueNumber, issueBody, repoOwner)) {
        console.log(`Circular dependency detected for issue #${issueNumber}, skipping dispatch`);
        await addIssueComment(
          repoOwner,
          repoName,
          issueNumber,
          token,
          `⚠️ **Circular Dependency Detected**\n\nThis issue has circular dependencies and cannot be dispatched automatically. Please review the \`depends_on:\` and \`then:\` references.`
        );
        continue;
      }

      // All checks passed, add agent label
      console.log(`Dispatching issue #${issueNumber} (depends_on satisfied)`);
      await githubRequest(
        `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ labels: [TRIGGER_LABEL] }),
        },
        [200]
      );
      dispatchedCount++;
    }

    console.log(
      `Task chaining complete for closed issue #${closedIssueNumber}: checked ${checkedCount} issues, dispatched ${dispatchedCount}`
    );
  } catch (error) {
    console.error(`Error during task chaining on issue close:`, error);
    // Don't throw - this is a side effect, shouldn't block issue close
  }
}

/**
 * Closes a cross-repo issue and posts a comment linking to the merged PR
 */
async function closeCrossRepoIssue(
  issueRepoOwner: string,
  issueRepoName: string,
  issueNumber: number,
  prRepoOwner: string,
  prRepoName: string,
  prNumber: number,
  prUrl: string,
  token: string
): Promise<void> {
  try {
    // Close the issue
    await githubRequest(
      `/repos/${issueRepoOwner}/${issueRepoName}/issues/${issueNumber}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      },
      [200]
    );
    console.log(`Closed cross-repo issue ${issueRepoOwner}/${issueRepoName}#${issueNumber}`);

    // Post a comment linking to the merged PR
    const commentBody = `Closed by merged PR: [${prRepoOwner}/${prRepoName}#${prNumber}](${prUrl})`;
    await addIssueComment(
      issueRepoOwner,
      issueRepoName,
      issueNumber,
      token,
      commentBody
    );
  } catch (error) {
    console.error(
      `Failed to close cross-repo issue ${issueRepoOwner}/${issueRepoName}#${issueNumber}:`,
      error
    );
    // Don't fail the entire flow if closing one issue fails
  }
}

async function createFollowUpIssue(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  prTitle: string,
  prUrl: string,
  token: string
): Promise<string | null> {
  try {
    // Determine follow-up issue type based on PR title
    let followUpTitle: string;
    let followUpType: "tests" | "documentation" | "review";

    const lowerTitle = prTitle.toLowerCase();
    if (lowerTitle.includes("test") || lowerTitle.includes("spec")) {
      followUpType = "documentation";
      followUpTitle = `Document: ${prTitle}`;
    } else if (lowerTitle.includes("doc") || lowerTitle.includes("readme")) {
      followUpType = "review";
      followUpTitle = `Review implementation: ${prTitle}`;
    } else {
      followUpType = "tests";
      followUpTitle = `Write tests for: ${prTitle}`;
    }

    const followUpBody = `## Context
This follow-up issue was automatically created after PR #${prNumber} was merged.

**Original PR:** ${prUrl}

## Task
Add ${followUpType} for the changes introduced in the merged PR above.

---
*This issue was auto-created by the agent task chaining system. Add the \`agent\` label if you'd like the agent to handle this follow-up work.*`;

    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: followUpTitle,
          body: followUpBody,
        }),
      },
      [201]
    );

    const issue = await response.json() as any;
    console.log(`Created follow-up issue #${issue.number} for merged PR #${prNumber}`);
    return issue.html_url;
  } catch (error) {
    console.error(`Failed to create follow-up issue for PR #${prNumber}:`, error);
    return null;
  }
}

async function recordFeedbackExample(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  taskMetadata: TaskMetadata,
  outcome: "merged" | "closed",
  token: string
): Promise<void> {
  try {
    const repoSlug = createRepoSlug(repoOwner, repoName);
    const exampleId = generateExampleId();
    const now = new Date().toISOString();

    // Fetch PR diff (truncate to 5KB for context)
    let prDiff: string | undefined;
    try {
      const diffResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
        token,
        { headers: { Accept: "application/vnd.github.v3.diff" } },
        [200]
      );
      const diffContent = await diffResponse.text();
      prDiff = diffContent.substring(0, 5000); // Truncate to 5KB
      console.log(`Fetched PR diff (${prDiff.length} bytes)`);
    } catch (error) {
      console.warn(`Failed to fetch PR diff: ${error}`);
    }

    // Create feedback example record
    const feedbackExample: FeedbackExample = {
      example_id: exampleId,
      repo_slug: repoSlug,
      task_type: taskMetadata.task_mode as "issue" | "pull_request",
      outcome,
      task_id: taskMetadata.task_id,
      task_payload: {
        task_id: taskMetadata.task_id,
        repo_slug: taskMetadata.repo_slug,
        requested_ref: taskMetadata.requested_ref,
        resolved_commit_sha: taskMetadata.resolved_commit_sha,
        issue_metadata: taskMetadata.issue_metadata,
        task_mode: taskMetadata.task_mode as "issue" | "pull_request" | "planning",
        created_at: taskMetadata.created_at,
      },
      pr_diff: prDiff,
      created_at: taskMetadata.created_at,
      outcome_at: now,
    };

    // Store feedback example to S3
    const exampleKey = createFeedbackExamplePath(repoSlug, outcome, exampleId);
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: exampleKey,
        Body: JSON.stringify(feedbackExample, null, 2),
        ContentType: "application/json",
      })
    );
    console.log(`Stored feedback example at ${exampleKey}`);

    // Update rolling index
    const indexKey = createFeedbackIndexPath(
      repoSlug,
      taskMetadata.task_mode as "issue" | "pull_request"
    );

    let index: FeedbackExampleIndex = {
      repo_slug: repoSlug,
      task_type: taskMetadata.task_mode as "issue" | "pull_request",
      examples: [],
      updated_at: now,
    };

    // Fetch existing index if it exists
    try {
      const indexResult = await s3.send(
        new GetObjectCommand({
          Bucket: ARTIFACTS_BUCKET,
          Key: indexKey,
        })
      );
      if (indexResult.Body) {
        const indexContent = await indexResult.Body.transformToString();
        index = JSON.parse(indexContent) as FeedbackExampleIndex;
      }
    } catch {
      // Index doesn't exist yet, use default
      console.log(`Creating new index at ${indexKey}`);
    }

    // Add new example to index
    index.examples.push({
      example_id: exampleId,
      outcome,
      created_at: taskMetadata.created_at,
      outcome_at: now,
    });

    // Keep only last 100 examples in index
    if (index.examples.length > 100) {
      index.examples = index.examples.slice(-100);
    }

    index.updated_at = now;

    // Store updated index
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: indexKey,
        Body: JSON.stringify(index, null, 2),
        ContentType: "application/json",
      })
    );
    console.log(`Updated feedback index at ${indexKey}`);
  } catch (error) {
    console.error(`Failed to record feedback example: ${error}`);
    // Don't fail the entire handler if feedback recording fails
  }
}

async function storeTaskMetadata(
  taskMetadata: TaskMetadata
): Promise<void> {
  const artifactKeys = createArtifactKeys(taskMetadata.artifact_prefix);

  try {
    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: artifactKeys.metadata,
      Body: JSON.stringify(taskMetadata, null, 2),
      ContentType: "application/json",
      Metadata: {
        taskId: taskMetadata.task_id,
        repoSlug: taskMetadata.repo_slug,
        issueNumber: taskMetadata.issue_number.toString(),
        status: taskMetadata.status,
      },
    }));

    console.log(`Stored task metadata at ${artifactKeys.metadata}`);
  } catch (error) {
    console.error(`Failed to store task metadata:`, error);
    throw error;
  }
}

function formatLaunchFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown launch error";
}

/**
 * Initializes credit balance for a repository if it doesn't exist
 * Default: 100 free credits for new repos
 */
async function initializeCreditBalance(repoSlug: string): Promise<CreditBalance> {
  const balance: CreditBalance = {
    repo_slug: repoSlug,
    current_balance: 100, // 100 free credits on signup
    total_purchased: 0,
    total_spent: 0,
    last_updated: new Date().toISOString(),
    version: 0,
  };

  const balancePath = createCreditBalancePath(repoSlug);
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: balancePath,
      Body: JSON.stringify(balance, null, 2),
      ContentType: "application/json",
    })
  );

  console.log(`Initialized credit balance for ${repoSlug}: 100 credits`);
  return balance;
}

/**
 * Fetches the current credit balance for a repository
 * Returns null if balance file doesn't exist
 */
async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const balancePath = createCreditBalancePath(repoSlug);
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
      return null;
    }
    throw error;
  }
}

/**
 * Records a credit transaction in the ledger
 */
async function recordTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const ledgerPath = createCreditLedgerPath(repoSlug);
  const transactionLine = JSON.stringify(transaction) + "\n";

  try {
    // Try to append if ledger exists
    const existing = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: ledgerPath,
      })
    );

    let existingContent = "";
    if (existing.Body) {
      existingContent = await existing.Body.transformToString();
    }

    const newContent = existingContent + transactionLine;
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: ledgerPath,
        Body: newContent,
        ContentType: "application/json",
      })
    );
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      // Ledger doesn't exist, create new one
      await s3.send(
        new PutObjectCommand({
          Bucket: ARTIFACTS_BUCKET,
          Key: ledgerPath,
          Body: transactionLine,
          ContentType: "application/json",
        })
      );
    } else {
      throw error;
    }
  }

  console.log(
    `Recorded credit transaction: ${transaction.type} ${transaction.amount} credits (${transaction.reason})`
  );
}

/**
 * Deducts credits from a repository balance after task completion
 */
async function deductCredits(
  repoSlug: string,
  taskId: string,
  model: string,
  status: "succeeded" | "failed" | "timed_out"
): Promise<number> {
  // Don't charge for failed/timed-out tasks
  if (status !== "succeeded") {
    const refundTransaction: CreditTransaction = {
      timestamp: new Date().toISOString(),
      type: "refund",
      amount: 0,
      reason: `Task ${taskId} did not complete successfully (status: ${status})`,
      task_id: taskId,
      model,
    };
    await recordTransaction(repoSlug, refundTransaction);
    return 0;
  }

  const cost = getModelCost(model);
  let balance = await getCreditBalance(repoSlug);

  if (!balance) {
    console.log(`Credit balance not found for ${repoSlug}, creating new balance`);
    balance = await initializeCreditBalance(repoSlug);
  }

  balance.current_balance -= cost;
  balance.total_spent += cost;
  balance.last_updated = new Date().toISOString();
  balance.version += 1;

  // Save updated balance
  const balancePath = createCreditBalancePath(repoSlug);
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: balancePath,
      Body: JSON.stringify(balance, null, 2),
      ContentType: "application/json",
    })
  );

  // Record transaction
  const transaction: CreditTransaction = {
    timestamp: new Date().toISOString(),
    type: "debit",
    amount: cost,
    reason: `Task ${taskId} completed`,
    task_id: taskId,
    model,
  };
  await recordTransaction(repoSlug, transaction);

  console.log(
    `Deducted ${cost} credits from ${repoSlug} for ${model}. New balance: ${balance.current_balance}`
  );
  return balance.current_balance;
}

/**
 * Checks if a repository has sufficient credits for a task
 * Initializes balance if it doesn't exist
 */
async function checkCreditsAvailable(repoSlug: string, model: string): Promise<boolean> {
  let balance = await getCreditBalance(repoSlug);

  if (!balance) {
    console.log(`No credit balance for ${repoSlug}, initializing with free credits`);
    balance = await initializeCreditBalance(repoSlug);
  }

  const cost = getModelCost(model);
  const available = balance.current_balance >= cost;

  console.log(
    `Credit check for ${repoSlug} (${model}): balance=${balance.current_balance}, required=${cost}, available=${available}`
  );

  return available;
}

function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  const expected = "sha256=" + hmac.digest("hex");
  if (signature.length !== expected.length) return false;
  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Loads or creates escalation configuration for a repository
 */
async function loadEscalationConfig(repoSlug: string): Promise<EscalationConfig> {
  try {
    const configPath = createEscalationConfigPath(repoSlug);
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: configPath,
      })
    );

    if (!result.Body) {
      return createDefaultEscalationConfig(repoSlug);
    }

    const content = await result.Body.transformToString();
    return JSON.parse(content) as EscalationConfig;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return createDefaultEscalationConfig(repoSlug);
    }
    throw error;
  }
}

function createDefaultEscalationConfig(repoSlug: string): EscalationConfig {
  return {
    repo_slug: repoSlug,
    enabled: true,
    failure_threshold: 3,
    pr_staleness_hours: 48,
    low_credit_threshold: 5,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Checks if an issue/PR should be escalated and triggers escalation if needed
 */
async function checkAndTriggerEscalations(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  isPR: boolean,
  labels: string[],
  taskStatus: "requested" | "failed",
  token: string
): Promise<void> {
  const repoSlug = createRepoSlug(repoOwner, repoName);
  try {
    const config = await loadEscalationConfig(repoSlug);

    if (!config.enabled) {
      console.log(`Escalation is disabled for ${repoSlug}`);
      return;
    }

    // Security-sensitive escalation: check for security labels
    if (labels.some((label) => label.toLowerCase().includes("security") || label.toLowerCase().includes("cve"))) {
      console.log(`Detected security label on ${repoSlug}#${issueNumber}, escalating`);
      // Escalation will be added by downstream processors
      return;
    }

    // Production config escalation: check if issue touches critical files
    const issueBody = await getIssueBody(repoOwner, repoName, issueNumber, token);
    if (
      issueBody &&
      (issueBody.includes("/.github/workflows") ||
        issueBody.includes("/deploy") ||
        issueBody.includes("infra/lib") ||
        issueBody.includes(".env") ||
        issueBody.includes("secrets") ||
        issueBody.includes("credentials"))
    ) {
      console.log(`Detected production config change on ${repoSlug}#${issueNumber}, escalating`);
      return;
    }

    // Note: Repeated failure, PR staleness, and low credits triggers are handled
    // by separate processors (daily-digest-handler, review-handler, escalation-handler)
  } catch (error) {
    const repoSlug = createRepoSlug(repoOwner, repoName);
    console.warn(`Failed to check escalation triggers for ${repoSlug}#${issueNumber}:`, error);
    // Don't fail the main handler if escalation check fails
  }
}

async function getIssueBody(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string
): Promise<string | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${issueNumber}`,
      token,
      { method: "GET" },
      [200]
    );
    const issueData = await response.json() as any;
    return issueData.body || null;
  } catch (error) {
    console.warn(`Failed to get issue body for #${issueNumber}:`, error);
    return null;
  }
}

/**
 * Resolves a reference (branch, tag, or pull request) to an immutable commit SHA
 */
async function resolveCommitSha(
  repoOwner: string,
  repoName: string,
  ref: string,
  isPR: boolean,
  issueNumber: number,
  token: string
): Promise<string> {
  try {
    if (isPR) {
      // For PRs, get the head commit SHA
      const response = await githubRequest(
        `/repos/${repoOwner}/${repoName}/pulls/${issueNumber}`,
        token,
        { method: "GET" },
        [200]
      );
      const prData = await response.json() as any;
      return prData.head.sha;
    } else {
      // For issues, resolve the default branch HEAD
      // First get the default branch
      const repoResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}`,
        token,
        { method: "GET" },
        [200]
      );
      const repoData = await repoResponse.json() as any;
      const defaultBranch = repoData.default_branch;

      // Then get the HEAD commit SHA of the default branch
      const branchResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}/branches/${defaultBranch}`,
        token,
        { method: "GET" },
        [200]
      );
      const branchData = await branchResponse.json() as any;
      return branchData.commit.sha;
    }
  } catch (error) {
    console.error(`Failed to resolve commit SHA for ${ref}:`, error);
    throw new Error(`Failed to resolve commit SHA for ${ref}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Finds the issue number associated with a PR's source branch
 * by looking up task metadata for the PR
 */
async function findIssueNumberForPR(
  repoSlug: string,
  prNumber: number
): Promise<number | null> {
  try {
    // Search for task metadata that references this PR
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACTS_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    if (!listResult.Contents) {
      return null;
    }

    // Search through metadata files for one that created this PR
    const metadataKeys = listResult.Contents
      .filter((obj: any) => obj.Key?.endsWith('/metadata.json'))
      .map((obj: any) => obj.Key!);

    for (const metadataKey of metadataKeys) {
      const result = await s3.send(new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: metadataKey,
      }));

      if (!result.Body) continue;

      try {
        const content = await result.Body.transformToString() as string;
        const metadata = JSON.parse(content) as TaskMetadata;

        // Check if this task created the PR we're looking at
        if (metadata.task_mode === "pull_request" &&
            metadata.issue_number === prNumber &&
            metadata.status === "succeeded") {
          return metadata.issue_metadata?.number ?? null;
        }
      } catch {
        // Skip malformed metadata files
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to find issue number for PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Checks if a PR has mergeable_state of "conflict" (has merge conflicts)
 */
async function getPRMergeableState(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string
): Promise<{ mergeable_state: string; mergeable: boolean | null } | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}`,
      token,
      { method: "GET" },
      [200]
    );

    const prData = await response.json() as any;
    return {
      mergeable_state: prData.mergeable_state, // "mergeable", "conflicting", "unknown"
      mergeable: prData.mergeable, // true, false, or null (unknown)
    };
  } catch (error) {
    console.error(`Failed to get PR mergeable state for #${prNumber}:`, error);
    return null;
  }
}

/**
 * Attempts to rebase a PR using gh pr update-branch
 * Returns true if rebase succeeded, false if failed
 */
async function attemptPRRebase(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string
): Promise<boolean> {
  try {
    // Use GitHub API to update branch (rebase)
    // This endpoint attempts to rebase the PR head onto the base branch
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/update-branch`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({ expected_head_sha: "" }), // Empty to auto-detect
      },
      [200, 202, 409, 422]
    );

    if (response.status === 200 || response.status === 202) {
      console.log(`Successfully initiated rebase for PR #${prNumber}`);
      return true;
    } else if (response.status === 409 || response.status === 422) {
      console.log(`Rebase failed for PR #${prNumber} (status ${response.status}) - conflicts cannot be auto-resolved`);
      return false;
    }

    return false;
  } catch (error) {
    console.error(`Exception during rebase attempt for PR #${prNumber}:`, error);
    return false;
  }
}

/**
 * Creates a fix issue for a PR that has unresolvable conflicts
 */
async function createConflictFixIssue(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  prTitle: string,
  prUrl: string,
  sourceIssueNumber: number | null,
  token: string
): Promise<string | null> {
  try {
    const fixIssueTitle = `Fix merge conflict: PR #${prNumber} (${prTitle})`;
    const sourceIssueRef = sourceIssueNumber ? `issue #${sourceIssueNumber}` : "PR #" + prNumber;

    const fixIssueBody = `## Context
A merge conflict was detected in PR #${prNumber} (created from ${sourceIssueRef}).

**Original PR:** ${prUrl}
**Title:** ${prTitle}

## Problem
When another PR was merged to the base branch, this PR developed unresolvable merge conflicts. The automatic rebase attempt failed.

## Task
Resolve the merge conflicts in PR #${prNumber} by:
1. Rebasing the PR onto the latest base branch
2. Resolving any conflicting files
3. Pushing the resolved changes

Once resolved, comment on PR #${prNumber} to trigger the automated review process.

---
*This issue was auto-created by the merge conflict detection system. Add the \`agent\` label if you'd like the agent to handle fixing the conflict.*`;

    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: fixIssueTitle,
          body: fixIssueBody,
          labels: [TRIGGER_LABEL], // Auto-label with agent to allow agent to fix
        }),
      },
      [201]
    );

    const issue = await response.json() as any;
    console.log(`Created conflict fix issue #${issue.number} for PR #${prNumber}`);
    return issue.html_url;
  } catch (error) {
    console.error(`Failed to create conflict fix issue for PR #${prNumber}:`, error);
    return null;
  }
}

/**
 * Scans open PRs for merge conflicts after a push to main
 */
async function handleMergeConflictDetection(
  repoOwner: string,
  repoName: string,
  token: string,
  appConfig: GitHubAppConfig
): Promise<void> {
  try {
    // Get list of open PRs
    const listPRsResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const openPRs = await listPRsResponse.json() as any[];
    console.log(`Found ${openPRs.length} open PRs, scanning for conflicts`);

    const repoSlug = createRepoSlug(repoOwner, repoName);
    const conflictingPRs: number[] = [];

    for (const pr of openPRs) {
      const prNumber = pr.number;
      const prTitle = pr.title;
      const prUrl = pr.html_url;

      // Check if PR has merge conflicts
      const mergeState = await getPRMergeableState(repoOwner, repoName, prNumber, token);
      if (!mergeState) {
        console.log(`Could not determine mergeable state for PR #${prNumber}, skipping`);
        continue;
      }

      // "conflicting" means there are merge conflicts
      if (mergeState.mergeable_state !== "conflicting") {
        console.log(`PR #${prNumber} has mergeable_state "${mergeState.mergeable_state}", no action needed`);
        continue;
      }

      console.log(`Found conflicting PR #${prNumber}: ${prTitle}`);
      conflictingPRs.push(prNumber);

      // Check if this PR was created by an agent task
      const sourceIssueNumber = await findIssueNumberForPR(repoSlug, prNumber);

      // If the PR wasn't created by agent, skip it (leave human PRs alone)
      if (!sourceIssueNumber) {
        console.log(`PR #${prNumber} was not created by agent task, skipping (not in scope)`);
        continue;
      }

      console.log(`PR #${prNumber} was created by agent issue #${sourceIssueNumber}, attempting auto-fix`);

      // Attempt rebase
      const rebaseSuccess = await attemptPRRebase(repoOwner, repoName, prNumber, token);

      if (rebaseSuccess) {
        // Rebase succeeded - post comment on PR
        const commentBody = `✅ **Auto-rebase successful**

The merge conflict was automatically resolved by rebasing this PR onto the latest \`${process.env.DEFAULT_BRANCH || 'main'}\` branch.

The PR is now ready for review.`;

        await addIssueComment(repoOwner, repoName, prNumber, token, commentBody);
        console.log(`Posted success comment on PR #${prNumber}`);
      } else {
        // Rebase failed - create a fix issue and post comment
        const fixIssueUrl = await createConflictFixIssue(
          repoOwner,
          repoName,
          prNumber,
          prTitle,
          prUrl,
          sourceIssueNumber,
          token
        );

        let commentBody = `❌ **Auto-rebase failed due to true conflicts**

The automatic rebase could not resolve this merge conflict. Manual intervention is required.`;

        if (fixIssueUrl) {
          commentBody += `\n\n🔧 **Fix issue created:** [#${fixIssueUrl.split('/').pop()}](${fixIssueUrl})\n\nPlease use the fix issue to resolve the conflicts.`;
        }

        await addIssueComment(repoOwner, repoName, prNumber, token, commentBody);
        console.log(`Posted failure comment on PR #${prNumber}`);
      }
    }

    if (conflictingPRs.length > 0) {
      console.log(
        `Conflict scan complete: ${conflictingPRs.length} conflicting PR(s) found and processed: ${conflictingPRs.join(", ")}`
      );
    } else {
      console.log("Conflict scan complete: no conflicting PRs found");
    }
  } catch (error) {
    console.error(`Error during merge conflict detection:`, error);
    throw error;
  }
}

function createTaskEnvironmentForDiagnostic(
  taskPayload: TaskPayload,
  issueData: any,
  artifactPrefix: string,
  githubToken: string,
  openrouterKey: string
): Record<string, string> {
  return {
    TASK_PAYLOAD: JSON.stringify({
      ...taskPayload,
      task_arn: undefined, // Will be filled in after task is created
    }),
    GITHUB_TOKEN: githubToken,
    OPENROUTER_API_KEY: openrouterKey,
    ARTIFACTS_BUCKET,
    ARTIFACT_PREFIX: artifactPrefix,
    TRIGGER_LABEL: DIAGNOSE_LABEL,
    SIGNAL_LABEL_RUNNING: "diagnose:running",
    SIGNAL_LABEL_WAITING: "diagnose:waiting",
    SIGNAL_LABEL_FAILED: "diagnose:failed",
    SIGNAL_LABEL_SUCCEEDED: "diagnose:succeeded",
  };
}

async function launchDiagnosticFargateTask(
  taskEnvironment: Record<string, string>
): Promise<void> {
  const params: RunTaskCommandInput = {
    cluster: CLUSTER_ARN,
    taskDefinition: DIAGNOSTIC_TASK_DEFINITION_ARN,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: SUBNETS.split(","),
        securityGroups: [SECURITY_GROUP],
        assignPublicIp: "ENABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: DIAGNOSTIC_CONTAINER_NAME,
          environment: Object.entries(taskEnvironment).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    },
  };

  const result = await ecs.send(new RunTaskCommand(params));
  const taskArn = result.tasks?.[0]?.taskArn;

  if (!taskArn || (result.failures?.length ?? 0) > 0) {
    const failureDetails =
      result.failures?.map((failure) => failure.reason ?? failure.arn ?? "unknown failure") ??
      [];
    throw new Error(
      failureDetails.length > 0
        ? `ECS diagnostic task launch failed: ${failureDetails.join(", ")}`
        : "ECS diagnostic task launch did not return a task ARN"
    );
  }

  console.log(`Started diagnostic Fargate task: ${taskArn}`);
}

/**
 * Checks if a workflow failure issue already exists for this workflow run
 */
async function checkExistingWorkflowFailureIssue(
  repoOwner: string,
  repoName: string,
  workflowName: string,
  token: string
): Promise<number | null> {
  try {
    // Search for open issues with specific label pattern and title
    const query = `repo:${repoOwner}/${repoName} is:issue is:open label:type:bug "${workflowName}" workflow`;
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=5`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "github-agent-control-plane",
        },
      }
    );

    if (!response.ok) {
      console.warn(`Failed to search for existing issues: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    if (data.items && data.items.length > 0) {
      console.log(`Found ${data.items.length} existing workflow failure issue(s)`);
      return data.items[0].number;
    }

    return null;
  } catch (error) {
    console.warn(`Failed to check for existing workflow issue: ${error}`);
    return null;
  }
}

/**
 * Extracts error messages from workflow run logs
 */
async function extractWorkflowErrorMessages(
  repoOwner: string,
  repoName: string,
  runId: number,
  token: string,
  failedJobName: string
): Promise<string> {
  try {
    // Get workflow run jobs
    const jobsResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/actions/runs/${runId}/jobs`,
      token,
      { method: "GET" },
      [200]
    );

    const jobsData = await jobsResponse.json() as any;
    const failedJob = jobsData.jobs?.find((j: any) => j.name === failedJobName && j.conclusion === "failure");

    if (!failedJob) {
      console.log(`Failed job "${failedJobName}" not found in workflow run`);
      return "Failed step information not available";
    }

    // Extract step information
    let errorMessage = "";
    const failedSteps = failedJob.steps?.filter((s: any) => s.conclusion === "failure") || [];

    if (failedSteps.length > 0) {
      const failedStep = failedSteps[0];
      errorMessage = `**Step:** ${failedStep.name}\n**Status:** ${failedStep.conclusion}\n`;
    }

    // Try to get logs from the failed job
    try {
      const logsUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/jobs/${failedJob.id}/logs`;
      const logsResponse = await fetch(logsUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "github-agent-control-plane",
        },
      });

      if (logsResponse.ok) {
        const logs = await logsResponse.text();
        // Extract last 20 lines of logs
        const logLines = logs.split("\n");
        const lastLines = logLines.slice(-20).join("\n");
        errorMessage += `\n**Last log lines:**\n\`\`\`\n${lastLines}\n\`\`\``;
      }
    } catch (logsError) {
      console.warn(`Could not fetch job logs: ${logsError}`);
      errorMessage += "\n*(Full logs could not be retrieved)*";
    }

    return errorMessage;
  } catch (error) {
    console.warn(`Failed to extract error messages: ${error}`);
    return "Error message extraction failed";
  }
}

/**
 * Determines if workflow is a deploy workflow and the environment
 */
function parseWorkflowEnvironment(
  workflowName: string
): { isDeployWorkflow: boolean; environment?: "production" | "staging" } {
  const lowerName = workflowName.toLowerCase();

  if (lowerName.includes("production") || lowerName.includes("prod deploy")) {
    return { isDeployWorkflow: true, environment: "production" };
  }

  if (lowerName.includes("staging") || lowerName.includes("stage")) {
    return { isDeployWorkflow: true, environment: "staging" };
  }

  if (lowerName.includes("deploy")) {
    return { isDeployWorkflow: true };
  }

  return { isDeployWorkflow: false };
}

/**
 * Handles workflow_run events with failure conclusion
 */
async function handleWorkflowRunFailure(
  repoOwner: string,
  repoName: string,
  workflowName: string,
  workflowRunId: number,
  workflowRunUrl: string,
  failedJobName: string,
  conclusion: string,
  token: string
): Promise<void> {
  try {
    const repoSlug = createRepoSlug(repoOwner, repoName);
    const { isDeployWorkflow, environment } = parseWorkflowEnvironment(workflowName);

    if (!isDeployWorkflow) {
      console.log(`Workflow "${workflowName}" is not a deploy workflow, skipping`);
      return;
    }

    console.log(
      `Handling workflow failure: ${workflowName} (run #${workflowRunId}) in ${repoSlug}`
    );

    // Check if an issue already exists for this workflow
    const existingIssueNumber = await checkExistingWorkflowFailureIssue(
      repoOwner,
      repoName,
      workflowName,
      token
    );

    if (existingIssueNumber) {
      console.log(`Found existing issue #${existingIssueNumber} for workflow failure`);

      // Update the existing issue with new failure information
      const errorMessages = await extractWorkflowErrorMessages(
        repoOwner,
        repoName,
        workflowRunId,
        token,
        failedJobName
      );

      const updateComment = `## Workflow Failure Detected (Run #${workflowRunId})

**Workflow:** [${workflowName}](${workflowRunUrl})
**Time:** ${new Date().toISOString()}
**Status:** ${conclusion}

**Failed Job:** ${failedJobName}

${errorMessages}`;

      await addIssueComment(repoOwner, repoName, existingIssueNumber, token, updateComment);
      console.log(`Updated existing issue #${existingIssueNumber} with new failure`);
      return;
    }

    // Create new issue for this workflow failure
    const errorMessages = await extractWorkflowErrorMessages(
      repoOwner,
      repoName,
      workflowRunId,
      token,
      failedJobName
    );

    const issueTitle = `🚨 Deploy Workflow Failed: ${workflowName} (Run #${workflowRunId})`;

    const issueBody = `## Workflow Failure

**Workflow:** [${workflowName}](${workflowRunUrl})
**Repository:** ${repoSlug}
**Run ID:** ${workflowRunId}
**Status:** ${conclusion}
**Environment:** ${environment || "Unknown"}

### Failed Job

**Job Name:** ${failedJobName}

${errorMessages}

### Details

[View workflow run](${workflowRunUrl})

---
*This issue was auto-created by the deployment monitoring system. It indicates a failure in the CI/CD deployment pipeline.*`;

    // Determine labels based on environment
    const labels: string[] = ["type:bug"];

    if (environment === "production") {
      labels.push("priority:high", TRIGGER_LABEL); // Auto-trigger agent for prod failures
    } else if (environment === "staging") {
      labels.push("priority:medium");
    }

    // Create the issue
    const createResponse = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: issueTitle,
          body: issueBody,
          labels,
        }),
      },
      [201]
    );

    const createdIssue = await createResponse.json() as any;
    console.log(
      `Created workflow failure issue #${createdIssue.number} in ${repoSlug}`
    );

    // For production failures, post a comment to trigger immediate agent action
    if (environment === "production" && labels.includes(TRIGGER_LABEL)) {
      const triggerComment = `🚀 **Production Deployment Failure - Auto-triggering agent fix attempt**

This production deployment failure has been automatically escalated. The agent will attempt to diagnose and fix the issue.`;
      await addIssueComment(repoOwner, repoName, createdIssue.number, token, triggerComment);
    }
  } catch (error) {
    console.error(`Failed to handle workflow run failure: ${error}`);
    throw error;
  }
}

/**
 * Check if there is already an active (running) task for a given issue.
 * Returns true if an active task is found, false otherwise.
 * On error, returns false so we don't block launches.
 */
async function checkForActiveTasks(
  repoSlug: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: prefix,
        MaxKeys: 200,
      })
    );

    const contents = listResult.Contents || [];
    const metadataKeys = contents
      .map((obj) => obj.Key!)
      .filter((key) => key.endsWith("/metadata.json"));

    for (const key of metadataKeys) {
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: ARTIFACTS_BUCKET,
            Key: key,
          })
        );
        const body = await result.Body!.transformToString();
        const metadata = JSON.parse(body);

        if (
          metadata.issue_number === issueNumber &&
          metadata.status === "running"
        ) {
          console.log(
            `Found active task for issue #${issueNumber}: ${key}`
          );
          return true;
        }
      } catch {
        // Skip unreadable metadata files
        continue;
      }
    }

    return false;
  } catch (error) {
    console.error(
      `Error checking for active tasks (non-blocking): ${error}`
    );
    return false;
  }
}

/**
 * Counts the number of currently running tasks for a specific repo
 * Returns the count or 0 on error
 */
async function countConcurrentTasks(repoSlug: string): Promise<number> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: prefix,
        MaxKeys: 1000,
      })
    );

    const contents = listResult.Contents || [];
    const metadataKeys = contents
      .map((obj) => obj.Key!)
      .filter((key) => key.endsWith("/metadata.json"));

    let runningCount = 0;
    for (const key of metadataKeys) {
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: ARTIFACTS_BUCKET,
            Key: key,
          })
        );
        const body = await result.Body!.transformToString();
        const metadata = JSON.parse(body);

        if (metadata.status === "running") {
          runningCount++;
        }
      } catch {
        // Skip unreadable metadata files
        continue;
      }
    }

    console.log(`Repo ${repoSlug} has ${runningCount} concurrently running tasks`);
    return runningCount;
  } catch (error) {
    console.error(
      `Error counting concurrent tasks for ${repoSlug} (non-blocking): ${error}`
    );
    return 0;
  }
}

/**
 * Checks if a task is already running or queued for the same issue
 * Prevents duplicate task dispatch for the same issue number
 */
async function hasRunningTaskForIssue(
  repoSlug: string,
  issueNumber: number
): Promise<boolean> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: prefix,
        MaxKeys: 1000,
      })
    );

    const contents = listResult.Contents || [];
    const metadataKeys = contents
      .map((obj) => obj.Key!)
      .filter((key) => key.endsWith("/metadata.json"));

    for (const key of metadataKeys) {
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: ARTIFACTS_BUCKET,
            Key: key,
          })
        );
        const body = await result.Body!.transformToString();
        const metadata = JSON.parse(body);

        // Check if any running/queued task is for the same issue number
        if (
          (metadata.status === "running" || metadata.status === "queued") &&
          metadata.issue_metadata?.number === issueNumber
        ) {
          return true;
        }
      } catch {
        // Skip unreadable metadata files
        continue;
      }
    }

    return false;
  } catch (error) {
    console.error(
      `Error checking for duplicate task for issue #${issueNumber} (non-blocking): ${error}`
    );
    return false;
  }
}

export async function handler(event: {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}) {
  console.log("Received webhook event");

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  // --- Validate signature ---
  const signature =
    event.headers["x-hub-signature-256"] ??
    event.headers["X-Hub-Signature-256"] ??
    "";
  if (!signature) {
    console.error("Missing signature header");
    return { statusCode: 401, body: "Missing signature" };
  }

  const webhookSecret = await getParameter(WEBHOOK_SECRET_PARAM);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.error("Invalid signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  // --- Parse payload ---
  const payload = JSON.parse(rawBody);
  const ghEvent =
    event.headers["x-github-event"] ??
    event.headers["X-GitHub-Event"] ??
    "";

  console.log(`GitHub event: ${ghEvent}, action: ${payload.action}`);

  let repoOwner: string;
  let repoName: string;
  let issueNumber: number;
  let isPR = false;
  let requestedRef: string;
  let issueData: any;
  let prData: any;

  if (ghEvent === "issues" && payload.action === "labeled") {
    const labelName = payload.label?.name?.toLowerCase();

    // Handle diagnostic label
    if (labelName === DIAGNOSE_LABEL) {
      console.log(`Handling diagnostic label on issue #${payload.issue.number}`);

      repoOwner = payload.repository.owner.login;
      repoName = payload.repository.name;
      issueNumber = payload.issue.number;
      isPR = false;
      requestedRef = payload.repository.default_branch || "main";
      issueData = payload.issue;

      // Launch diagnostic task
      try {
        // Get GitHub App credentials and mint installation token
        const [appId, privateKey, openrouterKey] = await Promise.all([
          getParameter(GITHUB_APP_ID_PARAM),
          getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
          getParameter(OPENROUTER_API_KEY_PARAM),
        ]);

        const appConfig: GitHubAppConfig = { appId, privateKey };
        const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

        const taskPayload: TaskPayload = {
          task_id: generateTaskId(),
          repo_slug: createRepoSlug(repoOwner, repoName),
          requested_ref: requestedRef,
          resolved_commit_sha: payload.repository.default_branch_commit?.sha || "HEAD",
          task_mode: "diagnostic",
          model: "anthropic/claude-haiku-4-5",
          issue_metadata: {
            number: issueNumber,
            title: issueData.title || "",
            body: issueData.body || "",
            labels: (issueData.labels || []).map((l: any) => l.name),
            author: issueData.user?.login || "unknown",
          },
          created_at: new Date().toISOString(),
        };

        const artifactPrefix = `tasks/${taskPayload.task_id}`;
        const env = createTaskEnvironmentForDiagnostic(
          taskPayload,
          issueData,
          artifactPrefix,
          githubToken,
          openrouterKey
        );

        console.log(`Launching diagnostic Fargate task: ${taskPayload.task_id}`);
        await launchDiagnosticFargateTask(env);

        return {
          statusCode: 202,
          body: JSON.stringify({
            message: "Diagnostic task launched",
            task_id: taskPayload.task_id,
          }),
        };
      } catch (error) {
        console.error("Failed to launch diagnostic task:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: "Failed to launch diagnostic task" }),
        };
      }
    }

    // Handle agent:succeeded label to trigger automatic review
    if (labelName === SIGNAL_LABEL_SUCCEEDED) {
      console.log(`Handling agent:succeeded label on issue #${payload.issue.number}`);

      const repoOwner = payload.repository.owner.login;
      const repoName = payload.repository.name;
      const issueNumber = payload.issue.number;

      try {
        // Get GitHub App credentials and mint installation token
        const [appId, privateKey, openrouterKey] = await Promise.all([
          getParameter(GITHUB_APP_ID_PARAM),
          getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
          getParameter(OPENROUTER_API_KEY_PARAM),
        ]);

        const appConfig: GitHubAppConfig = { appId, privateKey };
        const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

        // Find the PR created by the succeeded task
        const pr = await findPRCreatedBySucceededTask(
          repoOwner,
          repoName,
          issueNumber,
          githubToken
        );

        if (pr) {
          console.log(`Found PR #${pr.pr_number} created by issue #${issueNumber}`);

          // Check CI status before triggering review
          const checkStatus = await getPRCheckStatus(repoOwner, repoName, pr.pr_number, githubToken);
          console.log(`PR #${pr.pr_number} check status:`, checkStatus);

          if (checkStatus && checkStatus.conclusion !== "success") {
            // CI failed - need to determine if it's agent's fault or pre-existing main issue
            console.log(`CI failed for PR #${pr.pr_number}. Failures:`, checkStatus.failures);

            const mainIsHealthy = await getMainCIHealth(repoOwner, repoName, githubToken);
            console.log(`Main branch CI health: ${mainIsHealthy ? "healthy" : "broken"}`);

            if (mainIsHealthy) {
              // CI failed and main is healthy - this is the agent's fault, re-trigger agent
              console.log(`Main is healthy but PR checks failed. Re-triggering agent for PR #${pr.pr_number}`);

              // Remove agent:succeeded label and add agent label to re-trigger
              await setSignalLabel(repoOwner, repoName, issueNumber, githubToken, TRIGGER_LABEL);

              // Add informational comment
              await addIssueComment(
                repoOwner,
                repoName,
                pr.pr_number,
                githubToken,
                `⚠️ **CI Check Failed - Re-triggering Agent**\n\nThe CI checks failed for this PR:\n${checkStatus.failures.map((f) => `- ${f}`).join("\n")}\n\nSince the main branch is healthy, this appears to be the agent's fault. The agent is being re-triggered to fix the issues.`
              );

              return {
                statusCode: 200,
                body: JSON.stringify({
                  message: "CI failed - re-triggering agent",
                  issueNumber,
                  prNumber: pr.pr_number,
                  failures: checkStatus.failures,
                }),
              };
            } else {
              // CI failed but main is also broken - escalate with label, but still proceed with review
              console.log(`Main is also broken, escalating with blocked:main-broken label`);

              // Add the escalation label to the issue
              await githubRequest(
                `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
                githubToken,
                {
                  method: "POST",
                  body: JSON.stringify({ labels: [BLOCKED_MAIN_BROKEN_LABEL] }),
                },
                [200]
              );

              // Add informational comment on PR
              await addIssueComment(
                repoOwner,
                repoName,
                pr.pr_number,
                githubToken,
                `⚠️ **CI Check Failed - But Main Branch Also Broken**\n\nThe CI checks failed for this PR:\n${checkStatus.failures.map((f) => `- ${f}`).join("\n")}\n\nHowever, the main branch is also experiencing CI failures. The issue has been escalated with \`blocked:main-broken\` label. Proceeding with automated review anyway.`
              );
            }
          }

          // Proceed with review (either CI passed, or main is broken so we proceed anyway)
          const taskArn = await triggerReviewForPR(
            repoOwner,
            repoName,
            pr.pr_number,
            githubToken,
            openrouterKey
          );

          if (taskArn) {
            // Post informational comment on PR
            await addIssueComment(
              repoOwner,
              repoName,
              pr.pr_number,
              githubToken,
              `🔍 **Automated PR Review Started**\n\nThis PR was created by the agent and is now being automatically reviewed for:\n- ✅ CI/build status\n- ✅ Mergeability\n- ✅ Code quality and security\n- ✅ Compliance with acceptance criteria`
            );

            return {
              statusCode: 200,
              body: JSON.stringify({
                message: "Review triggered for agent-created PR",
                issueNumber,
                prNumber: pr.pr_number,
                prUrl: pr.pr_url,
              }),
            };
          } else {
            // Review task launch failed
            await addIssueComment(
              repoOwner,
              repoName,
              pr.pr_number,
              githubToken,
              `⚠️ **Failed to start automated review**\n\nThe automated review process could not be started. This PR requires manual review before merging.`
            );

            return {
              statusCode: 500,
              body: JSON.stringify({
                error: "Failed to trigger review task",
                issueNumber,
                prNumber: pr.pr_number,
              }),
            };
          }
        } else {
          console.log(`No PR found for issue #${issueNumber}, skipping review`);
          return {
            statusCode: 200,
            body: JSON.stringify({
              message: "No associated PR found",
              issueNumber,
            }),
          };
        }
      } catch (error) {
        console.error(`Failed to handle agent:succeeded for issue #${issueNumber}:`, error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Failed to process agent:succeeded event",
            issueNumber,
          }),
        };
      }
    }

    // Handle bot-summary label for digest publishing
    if (labelName === "bot-summary") {
      console.log(`Handling bot-summary label on issue #${payload.issue.number}`);
      try {
        await publishDigestToSocialMedia(
          payload.issue.title,
          payload.issue.body,
          payload.issue.html_url
        );
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Digest published to social media",
            issueNumber: payload.issue.number,
          }),
        };
      } catch (error) {
        console.error(`Failed to publish digest for issue #${payload.issue.number}:`, error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Failed to publish digest",
            issueNumber: payload.issue.number,
          }),
        };
      }
    }

    if (labelName !== TRIGGER_LABEL) {
      console.log(`Ignoring label: ${payload.label?.name}`);
      return { statusCode: 200, body: "Ignored: not the agent label" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.issue.number;
    isPR = false;
    requestedRef = payload.repository.default_branch || "main";
    issueData = payload.issue;
  } else if (ghEvent === "issues" && payload.action === "assigned") {
    // Check if the assignee is the agent bot
    const assignee = payload.assignee?.login;
    if (assignee !== "cenetex-coding-agent[bot]" && assignee !== "github-agent[bot]") {
      console.log(`Ignoring assignment to non-agent user: ${assignee}`);
      return { statusCode: 200, body: "Ignored: not assigned to agent bot" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.issue.number;
    isPR = false;
    requestedRef = payload.repository.default_branch || "main";
    issueData = payload.issue;
  } else if (ghEvent === "pull_request" && payload.action === "closed" && payload.pull_request.merged) {
    // Handle merged PR: close cross-repo issues and create follow-up issue
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const prTitle = payload.pull_request.title;
    const prUrl = payload.pull_request.html_url;
    const prBody = payload.pull_request.body || "";
    const repoSlug = createRepoSlug(repoOwner, repoName);

    console.log(`Handling merged PR #${prNumber}: ${prTitle}`);

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Parse PR body for issue references and close cross-repo issues
      const issueReferences = parseIssueReferences(prBody, repoOwner);
      const crossRepoIssues = issueReferences.filter((ref) => !ref.is_same_repo);

      if (crossRepoIssues.length > 0) {
        console.log(`Found ${crossRepoIssues.length} cross-repo issue reference(s) in PR #${prNumber}`);
        for (const issue of crossRepoIssues) {
          await closeCrossRepoIssue(
            issue.repo_owner,
            issue.repo_name,
            issue.issue_number,
            repoOwner,
            repoName,
            prNumber,
            prUrl,
            githubToken
          );
        }
      }

      // Handle task chaining: dispatch follow-up issues listed in "then:"
      await handleTaskChainingOnMerge(
        repoOwner,
        repoName,
        prNumber,
        prBody,
        githubToken
      );

      // Look up if this PR was created by an agent task
      const taskMetadata = await lookupTaskMetadataForPR(repoSlug, prNumber);

      if (taskMetadata) {
        console.log(`PR #${prNumber} was created by agent task ${taskMetadata.task_id}, recording feedback and creating follow-up issue`);

        // Record feedback example for this merged PR
        await recordFeedbackExample(
          repoOwner,
          repoName,
          prNumber,
          taskMetadata,
          "merged",
          githubToken
        );

        // Create follow-up issue
        const followUpUrl = await createFollowUpIssue(
          repoOwner,
          repoName,
          prNumber,
          prTitle,
          prUrl,
          githubToken
        );

        if (followUpUrl) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              message: "Follow-up issue created and feedback recorded",
              prNumber,
              followUpUrl,
              crossRepoIssuesClosed: crossRepoIssues.length
            }),
          };
        }
      } else {
        console.log(`PR #${prNumber} was not created by an agent task, skipping follow-up`);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "PR merged (no follow-up needed)",
          prNumber,
          crossRepoIssuesClosed: crossRepoIssues.length
        }),
      };
    } catch (error) {
      console.error(`Failed to handle merged PR #${prNumber}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to handle merged PR"
        }),
      };
    }
  } else if (ghEvent === "pull_request" && payload.action === "closed" && !payload.pull_request.merged) {
    // Handle closed PR (not merged): record as feedback example with human comments
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const prNumber = payload.pull_request.number;
    const prTitle = payload.pull_request.title;
    const repoSlug = createRepoSlug(repoOwner, repoName);

    console.log(`Handling closed PR #${prNumber} (not merged): ${prTitle}`);

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Look up if this PR was created by an agent task
      const taskMetadata = await lookupTaskMetadataForPR(repoSlug, prNumber);

      if (taskMetadata) {
        console.log(`PR #${prNumber} was created by agent task ${taskMetadata.task_id}, recording as failed example`);

        // Record feedback example with outcome: "closed"
        await recordFeedbackExample(
          repoOwner,
          repoName,
          prNumber,
          taskMetadata,
          "closed",
          githubToken
        );

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Closed PR feedback recorded",
            prNumber
          }),
        };
      } else {
        console.log(`PR #${prNumber} was not created by an agent task, skipping feedback`);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "PR closed (no feedback needed)",
          prNumber
        }),
      };
    } catch (error) {
      console.error(`Failed to handle closed PR #${prNumber}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to handle closed PR"
        }),
      };
    }
  } else if (ghEvent === "release" && payload.action === "published") {
    // Handle published release: trigger deploy and post confirmation
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const releaseTag = payload.release.tag_name;
    const releaseName = payload.release.name;
    const releaseUrl = payload.release.html_url;

    console.log(`Handling published release ${releaseTag} in ${repoOwner}/${repoName}`);

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Post confirmation comment on the release
      await githubRequest(
        `/repos/${repoOwner}/${repoName}/releases/${payload.release.id}/comments`,
        githubToken,
        {
          method: "POST",
          body: JSON.stringify({
            body: `🚀 **Release published and deploy triggered**\n\nRelease **${releaseName}** (${releaseTag}) has been published. The deployment pipeline has been triggered.`,
          }),
        },
        [200, 201]
      );

      console.log(`Posted confirmation comment on released ${releaseTag}`);

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Release published and deploy triggered",
          releaseTag,
          releaseName,
        }),
      };
    } catch (error) {
      console.error(`Failed to handle published release ${releaseTag}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to handle published release"
        }),
      };
    }
  } else if (ghEvent === "pull_request" && payload.action === "opened") {
    // Immediate review trigger for bot-created PRs
    const prAuthor = payload.pull_request.user.login;
    const isBotPR = CODING_AGENT_BOT_LOGINS.some(
      login => prAuthor === login || prAuthor.includes(login.replace("[bot]", ""))
    );

    if (!isBotPR) {
      console.log(`PR opened by ${prAuthor}, not a bot PR, skipping`);
      return { statusCode: 200, body: "Ignored: not a bot PR" };
    }

    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const prNumber = payload.pull_request.number;

    console.log(`Bot PR #${prNumber} opened by ${prAuthor}, triggering immediate review`);

    try {
      const [appId, privateKey, openrouterKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
        getParameter(OPENROUTER_API_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Check if PR touches protected paths
      const filesResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}/pulls/${prNumber}/files`,
        githubToken,
        { method: "GET" },
        [200]
      );
      const files = await filesResponse.json() as any[];
      const protectedFiles = files
        .map((f: any) => f.filename)
        .filter((filename: string) =>
          PROTECTED_PATHS.some(pattern => {
            if (pattern.includes("/") && filename.includes(pattern)) return true;
            if (pattern.includes("*")) return new RegExp(pattern.replace("*", ".*")).test(filename);
            return filename === pattern || filename.endsWith(`/${pattern}`);
          })
        );

      if (protectedFiles.length > 0) {
        console.log(`PR #${prNumber} touches protected paths: ${protectedFiles.join(", ")}`);

        await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues/${prNumber}/labels`,
          githubToken,
          { method: "POST", body: JSON.stringify({ labels: ["review:human-required"] }) },
          [200]
        );

        await addIssueComment(
          repoOwner, repoName, prNumber, githubToken,
          `🛡️ **Protected files detected**\n\nThis PR modifies files that require human review:\n${protectedFiles.map(f => `- \`${f}\``).join("\n")}\n\nThis PR will not be auto-merged and needs manual review.`
        );

        return {
          statusCode: 200,
          body: JSON.stringify({ message: "Bot PR touches protected paths", prNumber, protectedFiles }),
        };
      }

      // Trigger automated review immediately
      const taskArn = await triggerReviewForPR(repoOwner, repoName, prNumber, githubToken, openrouterKey);

      if (taskArn) {
        await addIssueComment(
          repoOwner, repoName, prNumber, githubToken,
          `🔍 **Automated PR Review Started**\n\nThis PR was opened by the coding agent and is now being automatically reviewed.`
        );
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ message: taskArn ? "Review triggered for bot PR" : "Review launch failed", prNumber }),
      };
    } catch (error) {
      console.error(`Failed to handle bot PR opened #${prNumber}:`, error);
      return { statusCode: 500, body: JSON.stringify({ error: "Failed to process bot PR opened event" }) };
    }
  } else if (ghEvent === "pull_request" && payload.action === "labeled") {
    const labelName = payload.label?.name;

    // Handle review:approved label for auto-merge scheduling
    if (labelName === REVIEW_APPROVED_LABEL) {
      const repoOwner = payload.repository.owner.login;
      const repoName = payload.repository.name;
      const prNumber = payload.pull_request.number;

      console.log(`Handling review:approved label on PR ${prNumber}`);

      try {
        // Get GitHub App credentials and mint installation token
        const [appId, privateKey] = await Promise.all([
          getParameter(GITHUB_APP_ID_PARAM),
          getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
        ]);

        const appConfig: GitHubAppConfig = { appId, privateKey };
        const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

        // Get the configured hold period (accounts for fast-track label, infra paths, etc.)
        const holdPeriodMinutes = await getMergeHoldConfig(repoOwner, repoName, githubToken, prNumber);

        // Schedule the auto-merge
        await scheduleAutoMerge(repoOwner, repoName, prNumber, githubToken, holdPeriodMinutes);

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Auto-merge scheduled",
            prNumber,
            holdPeriodMinutes
          }),
        };
      } catch (error) {
        console.error(`Failed to schedule auto-merge for PR ${prNumber}:`, error);
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Failed to schedule auto-merge"
          }),
        };
      }
    }

    // Handle agent trigger label
    if (labelName?.toLowerCase() !== TRIGGER_LABEL) {
      console.log(`Ignoring label: ${payload.label?.name}`);
      return { statusCode: 200, body: "Ignored: not the agent label" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.pull_request.number;
    isPR = true;
    requestedRef = payload.pull_request.head.ref;
    prData = payload.pull_request;
  } else if (ghEvent === "issues" && payload.action === "closed") {
    // Handle issue closure: scan for dependent issues blocked by this one
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const closedIssueNumber = payload.issue.number;

    console.log(`Handling closed issue #${closedIssueNumber} in ${repoOwner}/${repoName}`);

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Scan for dependent issues and dispatch unblocked ones
      await handleBlockerUnblock(
        repoOwner,
        repoName,
        closedIssueNumber,
        githubToken
      );

      // Handle task chaining: dispatch issues that depend on this one
      await handleTaskChainingOnIssueClose(
        repoOwner,
        repoName,
        closedIssueNumber,
        githubToken
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Issue closed, blocker scan completed",
          closedIssueNumber
        }),
      };
    } catch (error) {
      console.error(`Failed to handle closed issue #${closedIssueNumber}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to process issue closure"
        }),
      };
    }
  } else if (ghEvent === "push") {
    // Handle push event (PR merged to main) - scan for conflicts
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const pushedRef = payload.ref; // e.g., "refs/heads/main"
    const defaultBranch = payload.repository.default_branch || "main";

    // Only process pushes to the default branch (main/master)
    if (pushedRef !== `refs/heads/${defaultBranch}`) {
      console.log(`Ignoring push to non-default branch: ${pushedRef}`);
      return { statusCode: 200, body: "Ignored: not push to default branch" };
    }

    console.log(`Handling push to ${defaultBranch} in ${repoOwner}/${repoName}`);

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Check if main CI is now healthy - if so, unblock main-broken issues
      const mainIsNowHealthy = await getMainCIHealth(repoOwner, repoName, githubToken);
      if (mainIsNowHealthy) {
        console.log(`Main branch CI is now healthy, scanning for blocked:main-broken issues to unblock`);
        await unblockMainBrokenIssues(repoOwner, repoName, githubToken);
      } else {
        console.log(`Main branch CI is still broken, skipping auto-unblock`);
      }

      // Scan open PRs for merge conflicts
      await handleMergeConflictDetection(
        repoOwner,
        repoName,
        githubToken,
        appConfig
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Push to default branch processed, conflict scan completed"
        }),
      };
    } catch (error) {
      console.error(`Failed to handle push to ${defaultBranch}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to process push event"
        }),
      };
    }
  } else if (ghEvent === "workflow_run" && payload.action === "completed") {
    // Handle workflow_run events with failure conclusion - create issues for deploy failures
    const repoOwner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    const workflowRun = payload.workflow_run;
    const workflowName = payload.workflow?.name || workflowRun.name || "Unknown Workflow";
    const workflowRunId = workflowRun.id;
    const workflowRunUrl = workflowRun.html_url;
    const workflowConclusion = workflowRun.conclusion;

    // Only handle failures
    if (workflowConclusion !== "failure") {
      console.log(`Workflow run #${workflowRunId} concluded with ${workflowConclusion}, skipping`);
      return { statusCode: 200, body: `Ignored: workflow conclusion is ${workflowConclusion}` };
    }

    console.log(
      `Handling workflow_run failure: ${workflowName} (${repoOwner}/${repoName})`
    );

    try {
      // Get GitHub App credentials and mint installation token
      const [appId, privateKey] = await Promise.all([
        getParameter(GITHUB_APP_ID_PARAM),
        getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      ]);

      const appConfig: GitHubAppConfig = { appId, privateKey };
      const githubToken = await getInstallationToken(repoOwner, repoName, appConfig);

      // Determine the failed job name
      let failedJobName = "Unknown Job";
      if (workflowRun.jobs_url) {
        try {
          const jobsResponse = await githubRequest(
            `/repos/${repoOwner}/${repoName}/actions/runs/${workflowRunId}/jobs`,
            githubToken,
            { method: "GET" },
            [200]
          );
          const jobsData = await jobsResponse.json() as any;
          const failedJob = jobsData.jobs?.find((j: any) => j.conclusion === "failure");
          if (failedJob) {
            failedJobName = failedJob.name;
          }
        } catch (jobError) {
          console.warn(`Could not fetch job details: ${jobError}`);
        }
      }

      // Handle the workflow failure - this will create an issue or update existing one
      await handleWorkflowRunFailure(
        repoOwner,
        repoName,
        workflowName,
        workflowRunId,
        workflowRunUrl,
        failedJobName,
        workflowConclusion,
        githubToken
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Workflow failure processed",
          workflowName,
          workflowRunId,
        }),
      };
    } catch (error) {
      console.error(`Failed to handle workflow_run failure for ${workflowName}:`, error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to process workflow_run event",
          workflowName,
          workflowRunId,
        }),
      };
    }
  } else {
    console.log(`Ignoring event: ${ghEvent}/${payload.action}`);
    return { statusCode: 200, body: `Ignored: ${ghEvent}/${payload.action}` };
  }

  console.log(
    `Launching agent for ${repoOwner}/${repoName}#${issueNumber} (PR=${isPR})`
  );

  // --- Fetch GitHub App credentials and mint installation token ---
  const [appId, privateKey, openrouterKey] = await Promise.all([
    getParameter(GITHUB_APP_ID_PARAM),
    getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    getParameter(OPENROUTER_API_KEY_PARAM),
  ]);

  const appConfig: GitHubAppConfig = {
    appId,
    privateKey,
  };

  let githubToken: string;
  try {
    githubToken = await getInstallationToken(repoOwner, repoName, appConfig);
  } catch (error) {
    console.error(`Failed to get installation token for ${repoOwner}/${repoName}:`, error);
    throw new Error(`Failed to mint GitHub App installation token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // --- Prioritize reviews: launch pending bot PR reviews before new work ---
  if (!isPR) {
    const reviewsTriggered = await reviewPendingBotPRs(repoOwner, repoName, githubToken, openrouterKey);
    if (reviewsTriggered > 0) {
      console.log(`Launched ${reviewsTriggered} priority review(s) before new task for issue #${issueNumber}`);
    }
  }

  // --- Check for concurrency guard ---
  const issueLabels = await getIssueLabels(repoOwner, repoName, issueNumber, githubToken);
  if (issueLabels.includes(SIGNAL_LABEL_RUNNING)) {
    console.log(`Issue #${issueNumber} already has agent:running, skipping`);
    return { statusCode: 200, body: "Already running" };
  }

  // --- Check for active tasks in S3 metadata ---
  const repoSlug = createRepoSlug(repoOwner, repoName);
  if (await checkForActiveTasks(repoSlug, issueNumber)) {
    console.log(`Issue #${issueNumber} has an active task in S3, skipping`);
    return { statusCode: 200, body: "Already running (active task found)" };
  }

  // --- Check main CI health and block feature work if broken ---
  const mainIsHealthy = await getMainCIHealth(repoOwner, repoName, githubToken);
  if (!mainIsHealthy && !isPR) {
    // Main branch CI is broken - check if this is allowed work (bugs, hotfixes, CI fixes)
    const issueTitle = issueData.title;
    const isAllowed = isAllowedDespiteMainBroken(issueTitle, issueLabels, isPR ? "pull_request" : "issue");

    if (!isAllowed) {
      console.log(`Main CI is broken and issue #${issueNumber} is not a bug/critical fix - blocking dispatch`);

      await ensureSignalLabels(repoOwner, repoName, githubToken);

      // Add blocked label
      await githubRequest(
        `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
        githubToken,
        {
          method: "POST",
          body: JSON.stringify({ labels: [BLOCKED_MAIN_BROKEN_LABEL] }),
        },
        [200]
      );

      // Post informational comment
      await addIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        githubToken,
        `⛔ **Dispatch blocked: main branch CI is red**

The agent cannot dispatch feature work while the main branch has failing CI checks. This helps prevent wasting credits on PRs that will fail due to pre-existing issues.

**What's happening:**
- Main branch CI status: ❌ BROKEN
- Issue type: Feature work (not a bug fix or critical fix)

**To proceed:**
1. **Quick fix:** Get the main branch CI passing again
2. **Or:** Add a \`type:bug\` or \`priority:high\` label if this is actually a critical fix
3. **Or:** Include "fix:" or "CI" in the issue title

Once main is healthy or the issue is marked as a critical fix, re-label with \`agent\` to retry.`
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Dispatch blocked: main CI is broken",
          issueNumber,
          reason: "feature work on broken main"
        }),
      };
    } else {
      console.log(`Main CI is broken but issue #${issueNumber} is allowed (bug/critical fix), proceeding`);
    }
  }

  // --- Check for duplicate task dispatch ---
  const isDuplicate = await hasRunningTaskForIssue(repoSlug, issueNumber);
  if (isDuplicate) {
    console.log(`Task already running or queued for issue #${issueNumber}, rejecting duplicate dispatch`);

    await ensureSignalLabels(repoOwner, repoName, githubToken);

    // Post informational comment
    await addIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      githubToken,
      `⚠️ **Duplicate task dispatch rejected**

A task is already running or queued for this issue. To prevent conflicts, the duplicate task dispatch has been rejected.

If you believe this is an error, close and re-open the issue to clear the status, then re-label with \`agent\`.`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Duplicate dispatch rejected: task already running for this issue",
        issueNumber,
      }),
    };
  }

  // --- Check concurrency limit per repo ---
  const dispatchConfig = await getDispatchConfig(repoOwner, repoName, githubToken);
  const maxConcurrent = dispatchConfig.max_concurrent;
  const concurrentCount = await countConcurrentTasks(repoSlug);

  if (concurrentCount >= maxConcurrent) {
    console.log(
      `Concurrency limit reached for ${repoOwner}/${repoName}: ${concurrentCount}/${maxConcurrent} tasks running`
    );

    await ensureSignalLabels(repoOwner, repoName, githubToken);

    // Add queued label
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
      githubToken,
      {
        method: "POST",
        body: JSON.stringify({ labels: [QUEUED_LABEL] }),
      },
      [200]
    );

    // Post informational comment
    await addIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      githubToken,
      `⏸️ **Dispatch queued: concurrency limit reached**

This task has been queued because the repository is currently running at maximum concurrency (${concurrentCount}/${maxConcurrent} tasks).

The agent will automatically dispatch this task when capacity becomes available. No action is needed—just watch for the \`agent:running\` label to appear.`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Task queued: concurrency limit reached",
        issueNumber,
        concurrentCount,
        maxConcurrent
      }),
    };
  }

  await ensureSignalLabels(repoOwner, repoName, githubToken);
  await setSignalLabel(
    repoOwner,
    repoName,
    issueNumber,
    githubToken,
    SIGNAL_LABEL_RUNNING
  );

  // --- Resolve commit SHA ---
  console.log(`Resolving commit SHA for ref: ${requestedRef}`);
  const resolvedCommitSha = await resolveCommitSha(
    repoOwner,
    repoName,
    requestedRef,
    isPR,
    issueNumber,
    githubToken
  );
  console.log(`Resolved ${requestedRef} to commit SHA: ${resolvedCommitSha}`);

  // --- Create task payload ---
  const taskId = generateTaskId();

  // Extract label names from the webhook payload
  const labels = isPR
    ? (prData.labels || []).map((label: any) => label.name)
    : (issueData.labels || []).map((label: any) => label.name);

  const issueMetadata: IssueMetadata = {
    number: issueNumber,
    title: isPR ? prData.title : issueData.title,
    body: isPR ? prData.body : issueData.body,
    labels,
    head_ref: isPR ? prData.head.ref : undefined,
    base_ref: isPR ? prData.base.ref : undefined,
    author: isPR ? prData.user.login : issueData.user.login,
  };

  // --- Determine task mode ---
  let taskMode: "issue" | "pull_request" | "planning";
  if (isPR) {
    taskMode = "pull_request";
  } else if (labels.includes("planning")) {
    taskMode = "planning";
  } else {
    taskMode = "issue";
  }
  let selectedModel = getDefaultModel(taskMode);

  // Check for per-repo model override
  const repoModelConfig = await getRepoModelConfig(repoOwner, repoName, githubToken);
  if (repoModelConfig) {
    selectedModel = repoModelConfig;
    console.log(`Using repo-specific model from .github/AGENT.md: ${selectedModel}`);
  } else {
    console.log(`Using default model for ${taskMode}: ${selectedModel}`);
  }

  const taskPayload: TaskPayload = {
    task_id: taskId,
    repo_slug: repoSlug,
    requested_ref: requestedRef,
    resolved_commit_sha: resolvedCommitSha,
    issue_metadata: issueMetadata,
    task_mode: isPR ? "pull_request" : "issue",
    created_at: new Date().toISOString(),
    model: selectedModel,
  };

  console.log(`Created task ${taskId} with resolved SHA ${resolvedCommitSha}`);
  console.log(`Task payload:`, JSON.stringify(taskPayload, null, 2));

  // --- Check credit balance ---
  const hasCredits = await checkCreditsAvailable(repoSlug, selectedModel);
  if (!hasCredits) {
    const balance = await getCreditBalance(repoSlug);
    const cost = getModelCost(selectedModel);
    console.log(`Insufficient credits for task: required=${cost}, available=${balance?.current_balance ?? 0}`);

    // Ensure signal labels exist
    await ensureSignalLabels(repoOwner, repoName, githubToken);

    // Update GitHub issue with status:blocked label and credit error
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
      githubToken,
      {
        method: "POST",
        body: JSON.stringify({ labels: [STATUS_BLOCKED_LABEL] }),
      },
      [200]
    );

    await addIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      githubToken,
      `❌ **Insufficient credits to run this task**

This task requires ${cost} credits to run (model: \`${selectedModel}\`), but your repository account only has ${balance?.current_balance ?? 0} credits available.

**For this task:**
- Required: ${cost} credits
- Available: ${balance?.current_balance ?? 0} credits
- Shortfall: ${cost - (balance?.current_balance ?? 0)} credits

**To proceed:**
Add the \`agent\` label again after purchasing credits. Credits can be purchased through the billing dashboard.

**Note:** The agent will not launch until sufficient credits are available to prevent wasting container resources.`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Task rejected: insufficient credits",
        taskId,
        requiredCredits: cost,
        availableCredits: balance?.current_balance ?? 0,
      }),
    };
  }

  try {
    // --- Run Fargate task ---
    const taskMetadata = createInitialTaskMetadata(taskPayload);

    // Store task payload in S3 to avoid ECS container override size limit (8KB)
    const payloadS3Key = `${taskMetadata.artifact_prefix}/payload.json`;
    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: payloadS3Key,
      Body: JSON.stringify(taskPayload, null, 2),
      ContentType: "application/json",
    }));
    console.log(`Stored task payload at s3://${ARTIFACTS_BUCKET}/${payloadS3Key}`);

    const taskEnvironment: TaskEnvironment = {
      TASK_PAYLOAD_S3_KEY: payloadS3Key,
      TASK_PAYLOAD: JSON.stringify(taskPayload),
      GITHUB_TOKEN: githubToken,
      OPENROUTER_API_KEY: openrouterKey,
      ARTIFACTS_BUCKET,
      ARTIFACT_PREFIX: taskMetadata.artifact_prefix,
      TRIGGER_LABEL,
      SIGNAL_LABEL_RUNNING,
      SIGNAL_LABEL_WAITING,
      SIGNAL_LABEL_FAILED,
      SIGNAL_LABEL_SUCCEEDED,
    };

    const params: RunTaskCommandInput = {
      cluster: CLUSTER_ARN,
      taskDefinition: TASK_DEFINITION_ARN,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS.split(","),
          securityGroups: [SECURITY_GROUP],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: CONTAINER_NAME,
            environment: Object.entries(taskEnvironment).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
    };

    const result = await ecs.send(new RunTaskCommand(params));
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn || (result.failures?.length ?? 0) > 0) {
      const failureDetails =
        result.failures?.map((failure) => failure.reason ?? failure.arn ?? "unknown failure") ??
        [];
      throw new Error(
        failureDetails.length > 0
          ? `ECS task launch failed: ${failureDetails.join(", ")}`
          : "ECS task launch did not return a task ARN"
      );
    }

    console.log(`Started Fargate task: ${taskArn}`);
    console.log(`Task metadata - ID: ${taskId}, SHA: ${resolvedCommitSha}, Repo: ${repoSlug}`);

    // --- Store initial task metadata with ARN ---
    taskMetadata.task_arn = taskArn;
    taskMetadata.started_at = new Date().toISOString();
    taskMetadata.status = "running";
    await storeTaskMetadata(taskMetadata);

    // --- Deduct credits for this task ---
    try {
      await deductCredits(repoSlug, taskId, selectedModel, "succeeded");
    } catch (creditError) {
      console.error(`Failed to deduct credits for task ${taskId}: ${creditError}`);
      // Don't fail task launch if credit accounting fails
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Agent launched",
        taskArn,
        taskId,
        resolvedCommitSha,
        repoSlug
      }),
    };
  } catch (error) {
    const failureMessage = formatLaunchFailure(error);
    console.error(`Failed to launch agent task: ${failureMessage}`);

    try {
      await setSignalLabel(
        repoOwner,
        repoName,
        issueNumber,
        githubToken,
        SIGNAL_LABEL_FAILED
      );
      await addIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        githubToken,
        [
          "Agent failed before the runtime started.",
          "",
          `Launch error: ${failureMessage}`,
        ].join("\n")
      );
    } catch (reportingError) {
      console.error("Failed to report launch failure to GitHub", reportingError);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Agent launch failed" }),
    };
  }
}
