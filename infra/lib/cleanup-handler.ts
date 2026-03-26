import {
  ECSClient,
  DescribeTasksCommand,
  StopTaskCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import type { TaskMetadata, FeedbackExampleIndex } from "./types";
import {
  parseRepoSlug,
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
  CreditTransaction,
  createCreditBalancePath,
  createCreditLedgerPath,
  getModelCost,
} from "./types";

const ecs = new ECSClient({});
const s3 = new S3Client({});
const ssm = new SSMClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

// Tasks older than this are considered stale
const STALE_TASK_THRESHOLD_MINUTES = 60; // 1 hour
const SIGNAL_LABEL_FAILED = "agent:failed";

interface CleanupStats {
  tasksChecked: number;
  staleTasks: number;
  stoppedTasks: number;
  metadataUpdated: number;
  labelsUpdated: number;
  commentsPosted: number;
  feedbackExamplesArchived: number;
  errors: string[];
}

async function getTaskMetadata(metadataKey: string): Promise<TaskMetadata | null> {
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: metadataKey,
    }));

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as TaskMetadata;
  } catch (error) {
    console.error(`Failed to get metadata ${metadataKey}:`, error);
    return null;
  }
}

async function updateTaskMetadata(metadata: TaskMetadata): Promise<void> {
  const metadataKey = `${metadata.artifact_prefix}/metadata.json`;

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: metadataKey,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: "application/json",
    Metadata: {
      taskId: metadata.task_id,
      repoSlug: metadata.repo_slug,
      issueNumber: metadata.issue_number.toString(),
      status: metadata.status,
    },
  }));
}

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
      "User-Agent": "github-agent-cleanup",
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

async function deleteLabelIfPresent(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  try {
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      token,
      { method: "DELETE" },
      [200, 204, 404]
    );
  } catch (error) {
    console.error(`Failed to delete label ${label}:`, error);
  }
}

async function setSignalLabel(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  // Remove agent:running if present
  await deleteLabelIfPresent(repoOwner, repoName, issueNumber, token, "agent:running");

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

async function findStaleTaskMetadata(): Promise<TaskMetadata[]> {
  const staleThreshold = new Date(Date.now() - STALE_TASK_THRESHOLD_MINUTES * 60 * 1000);
  const staleMetadata: TaskMetadata[] = [];

  try {
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        // Filter for metadata.json files
        const metadataKeys = listResult.Contents
          .filter((obj: any) => obj.Key?.endsWith('/metadata.json'))
          .map((obj: any) => obj.Key!);

        // Check each metadata file
        for (const metadataKey of metadataKeys) {
          const metadata = await getTaskMetadata(metadataKey);
          if (!metadata) continue;

          // Check if task is stale and still in a running state
          if (metadata.status === "running" &&
              metadata.created_at &&
              new Date(metadata.created_at) < staleThreshold) {
            staleMetadata.push(metadata);
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

  } catch (error) {
    console.error("Failed to list task metadata:", error);
  }

  return staleMetadata;
}

async function isTaskStillRunning(taskArn: string): Promise<boolean> {
  try {
    const result = await ecs.send(new DescribeTasksCommand({
      cluster: CLUSTER_ARN,
      tasks: [taskArn],
    }));

    const task = result.tasks?.[0];
    if (!task) return false;

    return task.lastStatus === "RUNNING";
  } catch (error) {
    console.error(`Failed to describe task ${taskArn}:`, error);
    return false;
  }
}

async function stopTask(taskArn: string): Promise<boolean> {
  try {
    await ecs.send(new StopTaskCommand({
      cluster: CLUSTER_ARN,
      task: taskArn,
      reason: "Task exceeded time limit and was terminated by cleanup process",
    }));

    console.log(`Stopped stale task: ${taskArn}`);
    return true;
  } catch (error) {
    console.error(`Failed to stop task ${taskArn}:`, error);
    return false;
  }
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
        // For conflict detection, we also want to check "running" and "succeeded" states
        if (metadata.task_mode === "pull_request" &&
            metadata.issue_number === prNumber) {
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

async function checkForMergeConflicts(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<void> {
  console.log(`Checking for merge conflicts in ${repoOwner}/${repoName}`);

  try {
    // Get all open PRs created by the agent bot
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const prs = await response.json() as any[];

    // Filter for PRs created by the agent bot
    for (const pr of prs) {
      const isFromBot = pr.user.login === "cenetex-coding-agent[bot]" ||
                       pr.user.login.includes("github-agent") ||
                       pr.user.login.includes("coding-agent");

      if (!isFromBot) continue;

      // Check if PR is in a conflicting state
      if (pr.mergeable === false && pr.mergeable_state === "conflicting") {
        console.log(`Found conflicting PR #${pr.number}: ${pr.title}`);

        try {
          // Close the PR
          await githubRequest(
            `/repos/${repoOwner}/${repoName}/pulls/${pr.number}`,
            token,
            {
              method: "PATCH",
              body: JSON.stringify({ state: "closed" }),
            },
            [200]
          );

          console.log(`Closed conflicting PR #${pr.number}`);

          // Add a comment explaining the conflict
          await githubRequest(
            `/repos/${repoOwner}/${repoName}/issues/${pr.number}/comments`,
            token,
            {
              method: "POST",
              body: JSON.stringify({
                body: `🔄 **Merge conflict detected**

This PR has merge conflicts and cannot be merged. The PR has been automatically closed.

To resolve this issue:
1. The original issue will be automatically re-triggered to create a new PR against the updated main branch
2. Look for a new PR shortly with the same changes
3. If another PR also tries to merge conflicting changes, it will also be closed and re-triggered

This is an automated process to handle conflicts between parallel agent runs.`
              }),
            },
            [201]
          );

          console.log(`Added comment to conflicting PR #${pr.number}`);

          // Extract repo slug and look up the original issue to re-trigger it
          const repoSlug = `${repoOwner}/${repoName}`;

          // Find the task metadata for this PR to get the original issue number
          const taskMetadata = await lookupTaskMetadataForPR(repoSlug, pr.number);

          if (taskMetadata) {
            console.log(`Found task metadata for PR #${pr.number}, re-triggering issue #${taskMetadata.issue_number}`);

            // Remove agent:succeeded label and add agent label to re-trigger
            await githubRequest(
              `/repos/${repoOwner}/${repoName}/issues/${taskMetadata.issue_number}/labels/${encodeURIComponent("agent:succeeded")}`,
              token,
              { method: "DELETE" },
              [200, 204, 404]
            );

            console.log(`Removed agent:succeeded label from issue #${taskMetadata.issue_number}`);

            // Add the agent label to re-trigger
            await githubRequest(
              `/repos/${repoOwner}/${repoName}/issues/${taskMetadata.issue_number}/labels`,
              token,
              {
                method: "POST",
                body: JSON.stringify({ labels: ["agent"] }),
              },
              [200]
            );

            console.log(`Added agent label to issue #${taskMetadata.issue_number} to re-trigger`);

            // Add a comment to the original issue
            await githubRequest(
              `/repos/${repoOwner}/${repoName}/issues/${taskMetadata.issue_number}/comments`,
              token,
              {
                method: "POST",
                body: JSON.stringify({
                  body: `ℹ️ **Re-triggered due to merge conflict**

PR #${pr.number} had merge conflicts with the main branch and was closed. The agent has been re-triggered to create a new PR with the latest changes from main.`
                }),
              },
              [201]
            );

            console.log(`Added re-trigger comment to issue #${taskMetadata.issue_number}`);
          } else {
            console.log(`Could not find task metadata for PR #${pr.number}, skipping re-trigger`);
          }
        } catch (error) {
          console.error(`Failed to handle conflicting PR #${pr.number}:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`Failed to check for merge conflicts:`, error);
  }
}

async function archiveFeedbackExamples(): Promise<{ archived: number; errors: string[] }> {
  const result = { archived: 0, errors: [] as string[] };

  try {
    console.log("Starting feedback example archival process");

    // List all feedback index files in S3
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split("T")[0]; // YYYY-MM-DD

    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "feedback-examples/",
        Delimiter: "/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      // Process directory entries to find old feedback examples
      if (listResult.CommonPrefixes) {
        for (const prefix of listResult.CommonPrefixes) {
          if (!prefix.Prefix) continue;

          // Example structure: feedback-examples/{repoSlug}/{outcome}/{date}/
          const parts = prefix.Prefix.split("/").filter(p => p);

          // Skip if it's not the right structure
          if (parts.length < 3) continue;

          const date = parts[parts.length - 1];

          // Check if this is an old date
          if (date < cutoffDate) {
            console.log(`Archiving old feedback examples at ${prefix.Prefix}`);

            // List and delete all objects under this prefix
            let exContinuation: string | undefined;
            do {
              const exResult = await s3.send(new ListObjectsV2Command({
                Bucket: ARTIFACTS_BUCKET,
                Prefix: prefix.Prefix,
                ContinuationToken: exContinuation,
                MaxKeys: 1000,
              }));

              if (exResult.Contents) {
                for (const obj of exResult.Contents) {
                  try {
                    await s3.send(new DeleteObjectCommand({
                      Bucket: ARTIFACTS_BUCKET,
                      Key: obj.Key,
                    }));
                    result.archived++;
                  } catch (error) {
                    const errorMsg = `Failed to delete ${obj.Key}: ${error}`;
                    console.error(errorMsg);
                    result.errors.push(errorMsg);
                  }
                }
              }
              exContinuation = exResult.NextContinuationToken;
            } while (exContinuation);
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    console.log(`Feedback example archival completed. Archived ${result.archived} objects`);
  } catch (error) {
    const errorMsg = `Feedback archival process failed: ${error}`;
    console.error(errorMsg);
    result.errors.push(errorMsg);
  }

  return result;
}

export async function handler(): Promise<CleanupStats> {
  console.log("Starting cleanup process for stale agent tasks");

  const stats: CleanupStats = {
    tasksChecked: 0,
    staleTasks: 0,
    stoppedTasks: 0,
    metadataUpdated: 0,
    labelsUpdated: 0,
    commentsPosted: 0,
    feedbackExamplesArchived: 0,
    errors: [],
  };

  try {
    // Fetch GitHub credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    // Find stale task metadata
    const staleMetadata = await findStaleTaskMetadata();
    stats.tasksChecked = staleMetadata.length;
    stats.staleTasks = staleMetadata.length;

    console.log(`Found ${staleMetadata.length} potentially stale tasks`);

    for (const metadata of staleMetadata) {
      try {
        // Check if the ECS task is still running
        if (metadata.task_arn) {
          const stillRunning = await isTaskStillRunning(metadata.task_arn);

          if (stillRunning) {
            // Stop the running task
            const stopped = await stopTask(metadata.task_arn);
            if (stopped) {
              stats.stoppedTasks++;
            }
          }
        }

        // Update metadata to mark as timed out
        metadata.status = "timed_out";
        metadata.completed_at = new Date().toISOString();
        metadata.error_message = "Task exceeded time limit and was terminated by cleanup process";

        await updateTaskMetadata(metadata);
        stats.metadataUpdated++;

        // Refund credits for timed-out tasks (no charge for incomplete work)
        try {
          const model = (metadata as any).model || "default";
          const cost = getModelCost(model);
          const balancePath = createCreditBalancePath(metadata.repo_slug);

          // Read and update credit balance
          let balance;
          try {
            const balanceResult = await s3.send(new GetObjectCommand({
              Bucket: ARTIFACTS_BUCKET,
              Key: balancePath,
            }));
            if (balanceResult.Body) {
              balance = JSON.parse(await balanceResult.Body.transformToString());
            }
          } catch (error: any) {
            if (error.name !== "NoSuchKey") throw error;
          }

          if (balance) {
            balance.current_balance += cost;
            balance.total_spent = Math.max(0, balance.total_spent - cost);
            balance.last_updated = new Date().toISOString();
            balance.version += 1;
            await s3.send(new PutObjectCommand({
              Bucket: ARTIFACTS_BUCKET,
              Key: balancePath,
              Body: JSON.stringify(balance, null, 2),
              ContentType: "application/json",
            }));
          }

          // Record refund transaction in ledger
          const ledgerPath = createCreditLedgerPath(metadata.repo_slug);
          const transaction: CreditTransaction = {
            timestamp: new Date().toISOString(),
            type: "refund",
            amount: cost,
            reason: `Task ${metadata.task_id} timed out`,
            task_id: metadata.task_id,
            model,
          };
          const transactionLine = JSON.stringify(transaction) + "\n";
          try {
            const existing = await s3.send(new GetObjectCommand({
              Bucket: ARTIFACTS_BUCKET,
              Key: ledgerPath,
            }));
            const existingContent = existing.Body ? await existing.Body.transformToString() : "";
            await s3.send(new PutObjectCommand({
              Bucket: ARTIFACTS_BUCKET,
              Key: ledgerPath,
              Body: existingContent + transactionLine,
              ContentType: "application/json",
            }));
          } catch (error: any) {
            if (error.name === "NoSuchKey") {
              await s3.send(new PutObjectCommand({
                Bucket: ARTIFACTS_BUCKET,
                Key: ledgerPath,
                Body: transactionLine,
                ContentType: "application/json",
              }));
            } else {
              throw error;
            }
          }
          console.log(`Refunded ${cost} credits to ${metadata.repo_slug} for timed-out task: ${metadata.task_id}`);
        } catch (creditError) {
          console.error(`Failed to issue credit refund: ${creditError}`);
          // Don't fail cleanup if credit accounting fails
        }

        // Update GitHub labels and post comment
        try {
          const { owner, name } = parseRepoSlug(metadata.repo_slug);

          // Get fresh installation token for this repo
          const jwt = createGitHubAppJWT(appId, privateKey);
          const installationId = await getInstallationId(owner, name, jwt);
          const tokenResult = await createInstallationToken(installationId, jwt);
          const githubToken = tokenResult.token;

          // Set label to agent:failed
          await setSignalLabel(owner, name, metadata.issue_number, githubToken, SIGNAL_LABEL_FAILED);
          stats.labelsUpdated++;

          // Calculate elapsed time in minutes
          const elapsedMinutes = Math.round(
            (new Date(metadata.completed_at!).getTime() - new Date(metadata.created_at).getTime()) / (1000 * 60)
          );

          // Post timeout comment with S3 artifact link
          const artifactKey = `${metadata.artifact_prefix}/metadata.json`;
          const s3Url = `s3://${ARTIFACTS_BUCKET}/${artifactKey}`;
          const commentBody = `⏱️ **Task Timeout**

This autonomous task timed out after **${elapsedMinutes} minutes**. This was an infrastructure issue, not a code problem.

**Logs:** ${s3Url}

The task has been automatically terminated and marked as failed.`;

          await addIssueComment(owner, name, metadata.issue_number, githubToken, commentBody);
          stats.commentsPosted++;

          console.log(`Updated GitHub labels and posted comment for task: ${metadata.task_id}`);

        } catch (ghError) {
          const errorMsg = `Failed to update GitHub labels/comment for task ${metadata.task_id}: ${ghError}`;
          console.error(errorMsg);
          stats.errors.push(errorMsg);
          // Continue processing other tasks even if GitHub update fails
        }

        console.log(`Cleaned up stale task: ${metadata.task_id}`);

      } catch (error) {
        const errorMsg = `Failed to clean up task ${metadata.task_id}: ${error}`;
        console.error(errorMsg);
        stats.errors.push(errorMsg);
      }
    }

    // Check for merge conflicts in agent PRs
    console.log("Checking for merge conflicts in agent PRs...");
    try {
      // Get GitHub credentials for checking PRs
      const jwt = createGitHubAppJWT(appId, privateKey);

      // Check merge conflicts on known installations
      // In a full implementation, this would iterate over all app installations
      const repositoriesWithAgent = [
        { owner: "cenetex", name: "agent" },
        { owner: "aws-swarm", name: "aws-swarm" },
        { owner: "kyro", name: "kyro" },
        { owner: "ratibot", name: "ratibot" },
      ];

      for (const repo of repositoriesWithAgent) {
        try {
          const installationId = await getInstallationId(repo.owner, repo.name, jwt);
          const tokenResult = await createInstallationToken(installationId, jwt);
          const githubToken = tokenResult.token;

          await checkForMergeConflicts(repo.owner, repo.name, githubToken);
        } catch (error) {
          console.error(`Failed to check merge conflicts for ${repo.owner}/${repo.name}:`, error);
          stats.errors.push(`Failed to check merge conflicts for ${repo.owner}/${repo.name}: ${error}`);
        }
      }
    } catch (error) {
      console.error(`Failed to initialize merge conflict checking:`, error);
      stats.errors.push(`Failed to initialize merge conflict checking: ${error}`);
    }

    // Archive old feedback examples (30+ days old)
    console.log("Running feedback example archival...");
    const archivalResult = await archiveFeedbackExamples();
    stats.feedbackExamplesArchived = archivalResult.archived;
    if (archivalResult.errors.length > 0) {
      stats.errors.push(...archivalResult.errors);
    }

    console.log(`Cleanup completed. Stats:`, JSON.stringify(stats, null, 2));
    return stats;

  } catch (error) {
    const errorMsg = `Cleanup process failed: ${error}`;
    console.error(errorMsg);
    stats.errors.push(errorMsg);
    throw error;
  }
}