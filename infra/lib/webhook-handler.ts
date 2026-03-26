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
} from "./types";

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
const SIGNAL_LABEL_RUNNING = "agent:running";
const SIGNAL_LABEL_WAITING = "agent:waiting";
const SIGNAL_LABEL_FAILED = "agent:failed";
const SIGNAL_LABEL_SUCCEEDED = "agent:succeeded";
const REVIEW_APPROVED_LABEL = "review:approved";

// Auto-merge hold period (1 hour)
const MERGE_HOLD_PERIOD_MINUTES = 60;
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

    const content = await response.json();
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
  token: string
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
          commit_message: `Automatically merged by review agent after 1-hour hold period.`,
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
      `🤖 **Automatically merged** after 1-hour hold period.

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

The automated merge failed after the 1-hour hold period. Manual intervention required.

Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );

    return false;
  }
}

async function scheduleAutoMerge(
  repoOwner: string,
  repoName: string,
  prNumber: number,
  token: string
): Promise<void> {
  // The actual auto-merge is handled by the review handler Lambda which runs every 15 minutes
  // This function just posts an informational comment about the scheduled merge

  const mergeTime = new Date(Date.now() + MERGE_HOLD_PERIOD_MINUTES * 60 * 1000);
  const messageBody = `⏱️ **Auto-merge scheduled**

This PR is approved and will be automatically merged at **${mergeTime.toISOString()}** (in ${MERGE_HOLD_PERIOD_MINUTES} minutes) unless:

- The \`${REVIEW_APPROVED_LABEL}\` label is removed
- A \`pause-agent\` label is added
- The PR is closed manually
- Someone pushes new commits

To prevent auto-merge, remove the \`${REVIEW_APPROVED_LABEL}\` label or add the \`pause-agent\` label.`;

  await addIssueComment(repoOwner, repoName, prNumber, token, messageBody);

  console.log(`Auto-merge scheduled for PR ${prNumber} at ${mergeTime.toISOString()}`);
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

        // Schedule the auto-merge
        await scheduleAutoMerge(repoOwner, repoName, prNumber, githubToken);

        return {
          statusCode: 200,
          body: JSON.stringify({
            message: "Auto-merge scheduled",
            prNumber,
            holdPeriodMinutes: MERGE_HOLD_PERIOD_MINUTES
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

  // --- Check for concurrency guard ---
  const issueLabels = await getIssueLabels(repoOwner, repoName, issueNumber, githubToken);
  if (issueLabels.includes(SIGNAL_LABEL_RUNNING)) {
    console.log(`Issue #${issueNumber} already has agent:running, skipping`);
    return { statusCode: 200, body: "Already running" };
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
  const repoSlug = createRepoSlug(repoOwner, repoName);

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

    // Update GitHub issue with credit error
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
    const taskEnvironment: TaskEnvironment = {
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
