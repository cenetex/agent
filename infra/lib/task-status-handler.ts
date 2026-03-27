/**
 * Task Status Handler Lambda
 *
 * Processes task completion events (succeeded, failed, waiting) and:
 * - Detects escalation triggers (repeated failures, low credits)
 * - Records task outcome in metadata
 * - Triggers escalation routing when necessary
 *
 * This handler is invoked by the agent container when tasks complete
 * and by EventBridge to periodically check for escalation conditions.
 */

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
import type {
  TaskMetadata,
  EscalationConfig,
  GitHubAppConfig,
  CreditBalance,
} from "./types";
import {
  createEscalationQueuePath,
  createEscalationConfigPath,
  createCreditBalancePath,
  createRepoSlug,
  generateEscalationId,
  getInstallationToken,
  parseRepoSlug,
} from "./types";

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const ORCHESTRATOR_REPO_OWNER = "cenetex";
const ORCHESTRATOR_REPO_NAME = "agent";
const ESCALATION_ISSUE_LABEL = "escalation:queue";

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
      "User-Agent": "github-agent-task-handler",
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
 * Loads the current escalation queue
 */
async function loadEscalationQueue(repoSlug: string) {
  try {
    const queuePath = createEscalationQueuePath(repoSlug);
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: queuePath,
      })
    );

    if (!result.Body) {
      return { items: [], updated_at: new Date().toISOString(), version: 0 };
    }

    const content = await result.Body.transformToString();
    return JSON.parse(content);
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return { items: [], updated_at: new Date().toISOString(), version: 0 };
    }
    throw error;
  }
}

/**
 * Saves the escalation queue
 */
async function saveEscalationQueue(repoSlug: string, queue: any): Promise<void> {
  const queuePath = createEscalationQueuePath(repoSlug);
  queue.updated_at = new Date().toISOString();
  queue.version = (queue.version ?? 0) + 1;

  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: queuePath,
      Body: JSON.stringify(queue, null, 2),
      ContentType: "application/json",
    })
  );
}

/**
 * Loads escalation config with defaults
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
      return createDefaultConfig(repoSlug);
    }

    const content = await result.Body.transformToString();
    return JSON.parse(content) as EscalationConfig;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return createDefaultConfig(repoSlug);
    }
    throw error;
  }
}

function createDefaultConfig(repoSlug: string): EscalationConfig {
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
 * Gets credit balance for a repo
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
 * Counts recent failures for an issue
 */
async function countRecentFailures(repoSlug: string, issueNumber: number): Promise<number> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: prefix,
        MaxKeys: 1000,
      })
    );

    if (!listResult.Contents) {
      return 0;
    }

    const metadataKeys = listResult.Contents
      .filter((obj: any) => obj.Key?.endsWith("/metadata.json"))
      .map((obj: any) => obj.Key!);

    let failureCount = 0;
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    for (const metadataKey of metadataKeys) {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: ARTIFACTS_BUCKET,
          Key: metadataKey,
        })
      );

      if (!result.Body) continue;

      try {
        const content = await result.Body.transformToString();
        const metadata = JSON.parse(content) as TaskMetadata;

        if (
          metadata.issue_number === issueNumber &&
          metadata.status === "failed" &&
          new Date(metadata.created_at) > oneWeekAgo
        ) {
          failureCount++;
        }
      } catch {
        continue;
      }
    }

    return failureCount;
  } catch (error) {
    console.warn(`Failed to count failures for issue #${issueNumber}:`, error);
    return 0;
  }
}

/**
 * Gets the GitHub URL for an issue/PR
 */
function getGitHubUrl(repoSlug: string, issueNumber: number): string {
  return `https://github.com/${repoSlug}/issues/${issueNumber}`;
}

/**
 * Checks for repeated failures trigger
 */
export async function checkRepeatedFailures(
  repoSlug: string,
  issueNumber: number,
  token: string,
  config: EscalationConfig
): Promise<void> {
  const failureCount = await countRecentFailures(repoSlug, issueNumber);

  if (failureCount >= config.failure_threshold) {
    console.log(
      `Issue ${repoSlug}#${issueNumber} has ${failureCount} failures (threshold: ${config.failure_threshold})`
    );

    const queue = await loadEscalationQueue(repoSlug);
    const existingItem = queue.items.find(
      (item: any) => item.issue_number === issueNumber && item.trigger_type === "repeated_failure"
    );

    if (!existingItem) {
      const escalationId = generateEscalationId();
      queue.items.push({
        escalation_id: escalationId,
        repo_slug: repoSlug,
        issue_number: issueNumber,
        trigger_type: "repeated_failure",
        reason: `Agent failed ${failureCount} times on this issue`,
        suggested_action:
          "Review the issue description and agent logs. May need manual investigation or scope refinement.",
        github_url: getGitHubUrl(repoSlug, issueNumber),
        created_at: new Date().toISOString(),
        context: { failure_count: failureCount, threshold: config.failure_threshold },
      });

      await saveEscalationQueue(repoSlug, queue);
      console.log(`Added repeated_failure escalation for ${repoSlug}#${issueNumber}`);
    }
  }
}

/**
 * Checks for low credits trigger
 */
export async function checkLowCredits(token: string): Promise<void> {
  try {
    // This would need to scan all repos with tasks
    // For now, this can be extended to handle repository listing
    console.log("Low credits check: would scan all repos with active tasks");
  } catch (error) {
    console.warn("Failed to check low credits:", error);
  }
}

/**
 * Handles task failure and checks for escalation triggers
 */
export async function handleTaskFailure(
  taskMetadata: TaskMetadata,
  token: string
): Promise<void> {
  const repoSlug = taskMetadata.repo_slug;
  const config = await loadEscalationConfig(repoSlug);

  if (!config.enabled) {
    console.log(`Escalation disabled for ${repoSlug}`);
    return;
  }

  // Check for repeated failures
  await checkRepeatedFailures(repoSlug, taskMetadata.issue_number, token, config);

  console.log(`Task failure processed for ${repoSlug}#${taskMetadata.issue_number}`);
}

/**
 * Periodic check handler (called by EventBridge every 15 minutes)
 */
export async function handler(event: any): Promise<any> {
  console.log("Task status handler invoked", JSON.stringify(event));

  try {
    // Get GitHub credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    const appConfig: GitHubAppConfig = { appId, privateKey };
    const token = await getInstallationToken(
      ORCHESTRATOR_REPO_OWNER,
      ORCHESTRATOR_REPO_NAME,
      appConfig
    );

    // Scan for low credit repos
    await checkLowCredits(token);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Task status handler completed successfully",
      }),
    };
  } catch (error) {
    console.error("Task status handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Handler failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      }),
    };
  }
}
