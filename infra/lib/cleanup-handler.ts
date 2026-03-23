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
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import type { TaskMetadata } from "./types";
import {
  parseRepoSlug,
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
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

export async function handler(): Promise<CleanupStats> {
  console.log("Starting cleanup process for stale agent tasks");

  const stats: CleanupStats = {
    tasksChecked: 0,
    staleTasks: 0,
    stoppedTasks: 0,
    metadataUpdated: 0,
    labelsUpdated: 0,
    commentsPosted: 0,
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

    console.log(`Cleanup completed. Stats:`, JSON.stringify(stats, null, 2));
    return stats;

  } catch (error) {
    const errorMsg = `Cleanup process failed: ${error}`;
    console.error(errorMsg);
    stats.errors.push(errorMsg);
    throw error;
  }
}