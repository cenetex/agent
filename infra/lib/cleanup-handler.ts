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
  type TaskLifecycleState,
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
const SIGNAL_LABEL_RUNNING = "agent:running";
const QUEUED_LABEL = "agent:queued";
const TRIGGER_LABEL = "agent";

interface CleanupStats {
  tasksChecked: number;
  staleTasks: number;
  stoppedTasks: number;
  metadataUpdated: number;
  labelsUpdated: number;
  commentsPosted: number;
  feedbackExamplesArchived: number;
  retries: number;
  retriesSkipped: number;
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

function isTransientCategory(category: string): boolean {
  // Transient categories that should be retried
  const transientCategories = ["credit_exhaustion", "timeout", "external_service"];
  return transientCategories.includes(category.toLowerCase());
}

function classifyFailureAsTransient(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;

  const lowerError = errorMessage.toLowerCase();

  // Transient errors that are worth retrying
  if (lowerError.includes("insufficient credits") || lowerError.includes("credits")) return true;
  if (lowerError.includes("timeout") || lowerError.includes("60 minute")) return true;

  // Persistent errors that should not be retried
  if (lowerError.includes("launch failed")) return false;
  if (lowerError.includes("missing repo")) return false;
  if (lowerError.includes("auth") || lowerError.includes("authentication")) return false;
  if (lowerError.includes("permission")) return false;
  if (lowerError.includes("not found")) return false;

  // Default to persistent (conservative)
  return false;
}

async function findFailedTasksForRetry(): Promise<TaskMetadata[]> {
  const failedMetadata: TaskMetadata[] = [];
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

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

          // Look for failed tasks that are eligible for retry:
          // - Status is failed or timed_out
          // - Created > 2 hours ago (ensuring it's stable failure, not in cleanup window)
          // - Retry count < 2 (max 2 retries per issue)
          if ((metadata.status === "failed" || metadata.status === "timed_out") &&
              metadata.created_at &&
              new Date(metadata.created_at) < twoHoursAgo &&
              (metadata.retry_count ?? 0) < 2) {
            failedMetadata.push(metadata);
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

  } catch (error) {
    console.error("Failed to list failed task metadata:", error);
  }

  return failedMetadata;
}

async function retryFailedTasks(appId: string, privateKey: string): Promise<{ retries: number; skipped: number }> {
  const result = { retries: 0, skipped: 0 };

  try {
    console.log("Starting retry process for failed agent tasks");

    const failedTasks = await findFailedTasksForRetry();
    console.log(`Found ${failedTasks.length} eligible failed tasks to consider for retry`);

    for (const metadata of failedTasks) {
      try {
        // Check if failure is transient using the pre-categorized failure_category if available
        // Otherwise fall back to parsing error message (for backward compatibility)
        const isTransient = metadata.failure_category
          ? isTransientCategory(metadata.failure_category)
          : classifyFailureAsTransient(metadata.error_message);

        if (!isTransient) {
          console.log(`Skipping retry for task ${metadata.task_id}: persistent error (${metadata.failure_category || metadata.error_message})`);
          result.skipped++;
          continue;
        }

        console.log(`Retrying task ${metadata.task_id}: transient error (${metadata.failure_category || metadata.error_message})`);

        // Get GitHub token for this repo
        const { owner, name } = parseRepoSlug(metadata.repo_slug);
        const jwt = createGitHubAppJWT(appId, privateKey);
        const installationId = await getInstallationId(owner, name, jwt);
        const tokenResult = await createInstallationToken(installationId, jwt);
        const githubToken = tokenResult.token;

        // Update metadata with retry info
        const retryCount = (metadata.retry_count ?? 0) + 1;
        metadata.retry_count = retryCount;

        if (!metadata.retry_attempts) {
          metadata.retry_attempts = [];
        }

        metadata.retry_attempts.push({
          timestamp: new Date().toISOString(),
          reason: metadata.error_message || "Unknown failure",
          old_status: metadata.status as any,
        });

        // Reset status to allow re-triggering
        metadata.status = "requested";
        metadata.completed_at = undefined;

        await updateTaskMetadata(metadata);

        // Remove agent:failed label and add agent label to trigger re-run
        await deleteLabelIfPresent(owner, name, metadata.issue_number, githubToken, SIGNAL_LABEL_FAILED);
        await githubRequest(
          `/repos/${owner}/${name}/issues/${metadata.issue_number}/labels`,
          githubToken,
          {
            method: "POST",
            body: JSON.stringify({ labels: ["agent"] }),
          },
          [200]
        );

        // Post comment showing retry attempt
        const retryComment = `🔄 **Retry attempt ${retryCount}/${2}**

Previous failure: ${metadata.error_message}

Automatic retry triggered by cleanup handler. ${retryCount < 2 ? 'If this retry also fails, one more retry will be attempted.' : 'This is the final retry attempt - manual intervention will be required if this fails.'}`;

        await addIssueComment(owner, name, metadata.issue_number, githubToken, retryComment);

        result.retries++;
        console.log(`Triggered retry ${retryCount} for task ${metadata.task_id} on issue #${metadata.issue_number}`);

      } catch (error) {
        const errorMsg = `Failed to retry task ${metadata.task_id}: ${error}`;
        console.error(errorMsg);
        // Continue processing other failed tasks even if one retry fails
      }
    }

    console.log(`Retry process completed: ${result.retries} retried, ${result.skipped} skipped`);
  } catch (error) {
    console.error(`Retry process error: ${error}`);
  }

  return result;
}

/**
 * Processes queued issues and dispatches them if concurrency slots are available
 * Returns count of issues dequeued
 */
async function dequeueQueuedIssues(appId: string, privateKey: string): Promise<number> {
  try {
    console.log("Starting dequeue process for queued issues...");

    const jwt = createGitHubAppJWT(appId, privateKey);
    let dequeueCount = 0;

    // Find all unique repos with queued issues by scanning task metadata
    const reposList = new Set<string>();
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACTS_BUCKET,
      Prefix: "tasks/",
      Delimiter: "/",
      MaxKeys: 1000,
    }));

    if (listResult.CommonPrefixes) {
      for (const prefix of listResult.CommonPrefixes) {
        if (!prefix.Prefix) continue;
        const repoSlug = prefix.Prefix.replace("tasks/", "").replace("/", "");
        if (repoSlug) reposList.add(repoSlug);
      }
    }

    // Process each repo
    for (const repoSlug of reposList) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);
        const installationId = await getInstallationId(owner, name, jwt);
        const tokenResult = await createInstallationToken(installationId, jwt);
        const githubToken = tokenResult.token;

        // Count currently running tasks for this repo
        let runningCount = 0;
        const metadataListResult = await s3.send(new ListObjectsV2Command({
          Bucket: ARTIFACTS_BUCKET,
          Prefix: `tasks/${repoSlug}/`,
          MaxKeys: 1000,
        }));

        if (metadataListResult.Contents) {
          const metadataKeys = metadataListResult.Contents
            .map(obj => obj.Key!)
            .filter(key => key.endsWith("/metadata.json"));

          for (const key of metadataKeys) {
            try {
              const metadata = await getTaskMetadata(key);
              if (metadata && metadata.status === "running") {
                runningCount++;
              }
            } catch {
              continue;
            }
          }
        }

        // Get dispatch config to read max_concurrent setting
        const configUrl = `/repos/${owner}/${name}/contents/.github/AGENT.md`;
        const configResponse = await githubRequest(configUrl, githubToken, { method: "GET" }, [200, 404]);

        let maxConcurrent = 3; // default
        if (configResponse.status === 200) {
          const contentData = await configResponse.json() as any;
          if (contentData.type === "file" && contentData.content) {
            const decoded = Buffer.from(contentData.content as string, "base64").toString("utf8");
            const maxConcurrentMatch = decoded.match(/^max_concurrent:\s*(\d+)$/m);
            if (maxConcurrentMatch) {
              maxConcurrent = parseInt(maxConcurrentMatch[1], 10);
            }
          }
        }

        console.log(`Repo ${repoSlug}: ${runningCount}/${maxConcurrent} tasks running`);

        // If there's capacity, find and dispatch queued issues
        if (runningCount < maxConcurrent) {
          const availableSlots = maxConcurrent - runningCount;
          console.log(`Repo ${repoSlug} has ${availableSlots} available slot(s), checking for queued issues...`);

          // Find queued issues
          const issuesResponse = await githubRequest(
            `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(QUEUED_LABEL)}&per_page=100`,
            githubToken,
            { method: "GET" },
            [200]
          );
          const queuedIssues = await issuesResponse.json() as any[];

          // Dispatch up to availableSlots issues
          for (let i = 0; i < Math.min(availableSlots, queuedIssues.length); i++) {
            const issue = queuedIssues[i];
            console.log(`Dequeuing issue #${issue.number} from ${repoSlug}`);

            // Remove queued label and add agent label to trigger dispatch
            await githubRequest(
              `/repos/${owner}/${name}/issues/${issue.number}/labels/${encodeURIComponent(QUEUED_LABEL)}`,
              githubToken,
              { method: "DELETE" },
              [200, 204, 404]
            );

            await githubRequest(
              `/repos/${owner}/${name}/issues/${issue.number}/labels`,
              githubToken,
              {
                method: "POST",
                body: JSON.stringify({ labels: [TRIGGER_LABEL] }),
              },
              [200]
            );

            // Post comment about dequeue
            await githubRequest(
              `/repos/${owner}/${name}/issues/${issue.number}/comments`,
              githubToken,
              {
                method: "POST",
                body: JSON.stringify({
                  body: `✅ **Dequeued** — Capacity available!\n\nThis task was queued due to concurrency limit and is now being dispatched.`
                }),
              },
              [201]
            );

            dequeueCount++;
          }
        }
      } catch (repoError) {
        console.error(`Error processing repo ${repoSlug} for dequeue: ${repoError}`);
        // Continue with other repos
      }
    }

    console.log(`Dequeue process completed, dispatched ${dequeueCount} issues`);
    return dequeueCount;
  } catch (error) {
    console.error(`Error during dequeue process: ${error}`);
    return 0;
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
    retries: 0,
    retriesSkipped: 0,
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

    // Process automatic retries for failed tasks
    console.log("Running retry process for failed tasks...");
    const retryResult = await retryFailedTasks(appId, privateKey);
    stats.retries = retryResult.retries;
    stats.retriesSkipped = retryResult.skipped;

    // Dequeue issues and dispatch if capacity available
    console.log("Running dequeue process for queued issues...");
    const dequeueResult = await dequeueQueuedIssues(appId, privateKey);
    console.log(`Dequeued ${dequeueResult} issue(s)`);

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