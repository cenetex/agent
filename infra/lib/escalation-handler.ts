/**
 * Escalation Handler Lambda
 *
 * Manages escalation routing for items needing human attention:
 * - Detects escalation triggers (repeated failures, stale PRs, security issues, etc.)
 * - Maintains a visible escalation issue in cenetex/agent repository
 * - Optionally sends webhook notifications (Slack, Telegram, etc.)
 * - Automatically de-escalates items when resolved
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
  EscalationItem,
  EscalationQueue,
  EscalationConfig,
  GitHubAppConfig,
} from "./types";
import {
  createEscalationQueuePath,
  createEscalationConfigPath,
  createEscalationHistoryPath,
  createCreditBalancePath,
  generateEscalationId,
  getInstallationToken,
  createRepoSlug,
  type CreditBalance,
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
      "User-Agent": "github-agent-escalation",
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
 * Loads the current escalation queue from S3
 */
async function loadEscalationQueue(repoSlug: string): Promise<EscalationQueue> {
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
    return JSON.parse(content) as EscalationQueue;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return { items: [], updated_at: new Date().toISOString(), version: 0 };
    }
    throw error;
  }
}

/**
 * Saves the escalation queue to S3
 */
async function saveEscalationQueue(
  repoSlug: string,
  queue: EscalationQueue
): Promise<void> {
  const queuePath = createEscalationQueuePath(repoSlug);
  queue.updated_at = new Date().toISOString();
  queue.version += 1;

  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: queuePath,
      Body: JSON.stringify(queue, null, 2),
      ContentType: "application/json",
    })
  );

  console.log(`Saved escalation queue for ${repoSlug} (version ${queue.version})`);
}

/**
 * Logs escalation event to history
 */
async function logEscalationEvent(
  repoSlug: string,
  event: {
    escalation_id?: string;
    trigger_type: string;
    action: "created" | "resolved" | "notified";
    issue_number: number;
    reason: string;
  }
): Promise<void> {
  const historyPath = createEscalationHistoryPath(repoSlug);
  const eventLine = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  }) + "\n";

  try {
    // Try to append to existing history
    const existing = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: historyPath,
      })
    );

    let existingContent = "";
    if (existing.Body) {
      existingContent = await existing.Body.transformToString();
    }

    const newContent = existingContent + eventLine;
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: historyPath,
        Body: newContent,
        ContentType: "application/jsonl",
      })
    );
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      // History doesn't exist, create new
      await s3.send(
        new PutObjectCommand({
          Bucket: ARTIFACTS_BUCKET,
          Key: historyPath,
          Body: eventLine,
          ContentType: "application/jsonl",
        })
      );
    } else {
      throw error;
    }
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
 * Loads escalation configuration for a repo (with defaults)
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
 * Finds or creates a pinned escalation issue
 */
async function getOrCreateEscalationIssue(
  token: string
): Promise<number> {
  try {
    // Search for existing escalation issue
    const searchResponse = await githubRequest(
      `/search/issues?q=repo:${ORCHESTRATOR_REPO_OWNER}/${ORCHESTRATOR_REPO_NAME}+label:${ESCALATION_ISSUE_LABEL}+state:open&sort=created&order=desc`,
      token,
      { method: "GET" },
      [200]
    );

    const searchData = await searchResponse.json() as any;

    if (searchData.items && searchData.items.length > 0) {
      console.log(`Found existing escalation issue #${searchData.items[0].number}`);
      return searchData.items[0].number;
    }

    // Create new escalation issue
    console.log("Creating new escalation issue");
    const createResponse = await githubRequest(
      `/repos/${ORCHESTRATOR_REPO_OWNER}/${ORCHESTRATOR_REPO_NAME}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: "🚨 Escalations Queue",
          body: `# Active Escalations

This is an auto-maintained list of items requiring human attention. Each escalation includes context and suggested actions.

**Last updated:** ${new Date().toISOString()}

## Items Requiring Attention

_(Items will be listed here as they are escalated)_

---
*This issue is automatically managed by the escalation system. Do not edit the escalation items directly. Instead, resolve the underlying issue and the item will be automatically de-escalated.*`,
          labels: [ESCALATION_ISSUE_LABEL],
        }),
      },
      [201]
    );

    const issueData = await createResponse.json() as any;
    console.log(`Created new escalation issue #${issueData.number}`);
    return issueData.number;
  } catch (error) {
    console.error("Failed to get or create escalation issue:", error);
    throw error;
  }
}

/**
 * Updates the escalation issue body with current queue
 */
async function updateEscalationIssue(
  token: string,
  issueNumber: number,
  items: EscalationItem[]
): Promise<void> {
  let tableBody = "";

  if (items.length === 0) {
    tableBody = "_(No active escalations)_\n";
  } else {
    tableBody = "| Repo | Issue | Reason | Action |\n";
    tableBody += "|------|-------|--------|--------|\n";

    for (const item of items) {
      const [owner, repo] = item.repo_slug.split("/");
      const rowRepo = `${owner}/${repo}`;
      const rowIssue = `[#${item.issue_number}](${item.github_url})`;
      const rowAction = item.suggested_action.substring(0, 50) + (item.suggested_action.length > 50 ? "..." : "");
      tableBody += `| ${rowRepo} | ${rowIssue} | ${item.reason} | ${rowAction} |\n`;
    }
  }

  const body = `# Active Escalations

This is an auto-maintained list of items requiring human attention. Each escalation includes context and suggested actions.

**Last updated:** ${new Date().toISOString()}
**Total items:** ${items.length}

## Items Requiring Attention

${tableBody}

---
*This issue is automatically managed by the escalation system. Do not edit the escalation items directly. Instead, resolve the underlying issue and the item will be automatically de-escalated.*`;

  await githubRequest(
    `/repos/${ORCHESTRATOR_REPO_OWNER}/${ORCHESTRATOR_REPO_NAME}/issues/${issueNumber}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify({ body }),
    },
    [200]
  );

  console.log(`Updated escalation issue #${issueNumber} with ${items.length} items`);
}

/**
 * Sends a webhook notification for an escalation
 */
async function sendWebhookNotification(
  webhookUrl: string,
  item: EscalationItem
): Promise<void> {
  try {
    const message = {
      text: `🚨 **New Escalation**: ${item.repo_slug}#${item.issue_number}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${item.reason}*\n${item.suggested_action}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Issue" },
              url: item.github_url,
            },
          ],
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.warn(`Webhook notification failed: ${response.status}`);
    }
  } catch (error) {
    console.warn(`Failed to send webhook notification:`, error);
  }
}

/**
 * Removes an item from the escalation queue
 */
export async function removeEscalation(
  repoSlug: string,
  escalationId: string,
  token: string
): Promise<void> {
  const queue = await loadEscalationQueue(repoSlug);
  const itemIndex = queue.items.findIndex((item) => item.escalation_id === escalationId);

  if (itemIndex >= 0) {
    const removedItem = queue.items[itemIndex];
    queue.items.splice(itemIndex, 1);

    await saveEscalationQueue(repoSlug, queue);
    await logEscalationEvent(repoSlug, {
      escalation_id: escalationId,
      trigger_type: removedItem.trigger_type,
      action: "resolved",
      issue_number: removedItem.issue_number,
      reason: removedItem.reason,
    });

    // Update orchestrator issue
    const escalationIssue = await getOrCreateEscalationIssue(token);
    await updateEscalationIssue(token, escalationIssue, queue.items);

    console.log(`Removed escalation ${escalationId} from queue`);
  }
}

/**
 * Adds or updates an item in the escalation queue
 */
export async function addEscalation(
  repoSlug: string,
  issueNumber: number,
  triggerType: string,
  reason: string,
  suggestedAction: string,
  githubUrl: string,
  config: EscalationConfig,
  token: string,
  context?: Record<string, any>
): Promise<void> {
  const queue = await loadEscalationQueue(repoSlug);

  // Check if escalation already exists
  const existingIndex = queue.items.findIndex(
    (item) => item.issue_number === issueNumber && item.trigger_type === triggerType
  );

  const escalationId = existingIndex >= 0 ? queue.items[existingIndex].escalation_id : generateEscalationId();
  const item: EscalationItem = {
    escalation_id: escalationId,
    repo_slug: repoSlug,
    issue_number: issueNumber,
    trigger_type: triggerType as any,
    reason,
    suggested_action: suggestedAction,
    github_url: githubUrl,
    created_at: existingIndex >= 0 ? queue.items[existingIndex].created_at : new Date().toISOString(),
    context,
  };

  if (existingIndex >= 0) {
    queue.items[existingIndex] = item;
  } else {
    queue.items.push(item);
  }

  await saveEscalationQueue(repoSlug, queue);

  // Log event
  await logEscalationEvent(repoSlug, {
    escalation_id: escalationId,
    trigger_type: triggerType,
    action: "created",
    issue_number: issueNumber,
    reason,
  });

  // Update orchestrator issue
  const escalationIssue = await getOrCreateEscalationIssue(token);
  await updateEscalationIssue(token, escalationIssue, queue.items);

  // Send webhook notification if configured
  if (config.webhook_url && existingIndex < 0) {
    await sendWebhookNotification(config.webhook_url, item);
    await logEscalationEvent(repoSlug, {
      escalation_id: escalationId,
      trigger_type: triggerType,
      action: "notified",
      issue_number: issueNumber,
      reason: `Webhook notification sent to ${config.webhook_url}`,
    });
  }

  console.log(`Added/updated escalation ${escalationId} for ${repoSlug}#${issueNumber}`);
}

/**
 * Handler entry point for periodic escalation checks
 * Can be called by EventBridge on an interval (e.g., every 15 minutes)
 */
export async function handler(event: any): Promise<any> {
  console.log("Escalation handler invoked", JSON.stringify(event));

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

    // Ensure escalation issue exists
    await getOrCreateEscalationIssue(token);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Escalation handler completed successfully",
      }),
    };
  } catch (error) {
    console.error("Escalation handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: `Escalation handler failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      }),
    };
  }
}
