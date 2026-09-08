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
  CreditTransaction,
} from "./types";
import {
  createEscalationQueuePath,
  createEscalationConfigPath,
  createCreditBalancePath,
  createCreditLedgerPath,
  createRepoSlug,
  generateEscalationId,
  getInstallationToken,
  getModelCost,
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
 * Determines if a failure is retryable based on category
 */
function isRetryableFailure(failureCategory?: string): boolean {
  const retryableCategories = [
    "timeout",
    "credit_exhaustion",
    "external_service",
    "compilation_error",
  ];
  return failureCategory ? retryableCategories.includes(failureCategory) : false;
}

/**
 * Checks if a task should be auto-retried based on failure category and attempt count
 */
async function shouldAutoRetry(taskMetadata: TaskMetadata): Promise<boolean> {
  if (!isRetryableFailure(taskMetadata.failure_category)) {
    return false;
  }

  // Limit retries to prevent infinite loops
  const retryCount = taskMetadata.retry_count ?? 0;
  const maxRetries = taskMetadata.failure_category === "timeout" ? 2 : 1;

  return retryCount < maxRetries;
}

/**
 * Records a retry attempt in task metadata
 */
async function recordRetryAttempt(repoSlug: string, taskId: string): Promise<void> {
  try {
    // This would need to update the metadata in S3
    // For now, this is a placeholder for the retry tracking logic
    console.log(`Recording retry attempt for task ${taskId} in ${repoSlug}`);
  } catch (error) {
    console.warn(`Failed to record retry attempt:`, error);
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

  // Check if this should be auto-retried
  const shouldRetry = await shouldAutoRetry(taskMetadata);
  if (shouldRetry) {
    console.log(
      `Task ${taskMetadata.task_id} marked for auto-retry (category: ${taskMetadata.failure_category}, retry: ${(taskMetadata.retry_count ?? 0) + 1})`
    );
    await recordRetryAttempt(repoSlug, taskMetadata.task_id);
    // NOTE: Actual retry execution would be handled by webhook-handler or a separate handler
    return;
  }

  // Check for repeated failures
  await checkRepeatedFailures(repoSlug, taskMetadata.issue_number, token, config);

  console.log(`Task failure processed for ${repoSlug}#${taskMetadata.issue_number}`);
}

/**
 * Refunds dispatch-time credit reservations for tasks that ended in a
 * non-succeeded terminal state (failed / timed_out).
 *
 * Credits are debited when a task is dispatched, before any model work
 * happens, as a reservation against runaway spend. The documented policy is
 * that failed and timed-out tasks are not charged. This sweep makes that
 * policy hold even when a task dies before it can report an outcome
 * (bootstrap failures, sandbox crashes, network blackholes). It is
 * idempotent: a task_id is refunded at most once, keyed by the ledger.
 */
export async function reconcileCredits(): Promise<{
  scanned: number;
  refunded: number;
  errors: string[];
}> {
  const result = { scanned: 0, refunded: 0, errors: [] as string[] };

  // Collect terminal task metadata across all repos
  const terminalTasks = new Map<string, TaskMetadata[]>();
  let continuation: string | undefined;
  do {
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuation,
        MaxKeys: 1000,
      })
    );

    for (const obj of listResult.Contents ?? []) {
      const key = (obj as any).Key as string | undefined;
      if (!key || !key.endsWith("/metadata.json")) continue;
      try {
        const objResult = await s3.send(
          new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key })
        );
        if (!objResult.Body) continue;
        const metadata = JSON.parse(
          await objResult.Body.transformToString()
        ) as TaskMetadata;
        result.scanned++;
        if (
          (metadata.status === "failed" || metadata.status === "timed_out") &&
          metadata.repo_slug &&
          metadata.task_id
        ) {
          const list = terminalTasks.get(metadata.repo_slug) ?? [];
          list.push(metadata);
          terminalTasks.set(metadata.repo_slug, list);
        }
      } catch (error) {
        result.errors.push(`metadata ${key}: ${error}`);
      }
    }

    continuation = listResult.IsTruncated
      ? listResult.NextContinuationToken
      : undefined;
  } while (continuation);

  // Per repo: refund debited terminal tasks that have no refund yet
  for (const [repoSlug, tasks] of terminalTasks) {
    try {
      const { debited, refunded } = await loadLedgerTaskState(repoSlug);
      for (const task of tasks) {
        if (!debited.has(task.task_id) || refunded.has(task.task_id)) continue;
        await refundReservation(repoSlug, task);
        refunded.add(task.task_id);
        result.refunded++;
      }
    } catch (error) {
      result.errors.push(`ledger ${repoSlug}: ${error}`);
    }
  }

  return result;
}

/**
 * Pure decision core for credit reconciliation: given raw ledger lines, return
 * the set of task_ids that were debited and the set that already received a
 * real (non-zero) refund. Zero-amount refunds — the historical no-op recorded
 * by the completion-time refund path — do not count as refunded.
 */
export function ledgerTaskStateFromLines(lines: string[]): {
  debited: Set<string>;
  refunded: Set<string>;
} {
  const debited = new Set<string>();
  const refunded = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const txn = JSON.parse(line) as CreditTransaction;
      if (!txn.task_id) continue;
      if (txn.type === "debit") debited.add(txn.task_id);
      if (txn.type === "refund" && (txn.amount ?? 0) > 0) {
        refunded.add(txn.task_id);
      }
    } catch {
      continue; // skip malformed ledger lines
    }
  }
  return { debited, refunded };
}

/**
 * Reads every ledger object for a repo and returns the set of task_ids that
 * have a debit and the set that already have a (non-zero) refund.
 */
async function loadLedgerTaskState(
  repoSlug: string
): Promise<{ debited: Set<string>; refunded: Set<string> }> {
  const debited = new Set<string>();
  const refunded = new Set<string>();

  let continuation: string | undefined;
  do {
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: `credits/${repoSlug}/ledger/`,
        ContinuationToken: continuation,
      })
    );

    for (const obj of listResult.Contents ?? []) {
      const objResult = await s3.send(
        new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: (obj as any).Key })
      );
      if (!objResult.Body) continue;
      const content = await objResult.Body.transformToString();
      const fileState = ledgerTaskStateFromLines(content.split("\n"));
      for (const taskId of fileState.debited) debited.add(taskId);
      for (const taskId of fileState.refunded) refunded.add(taskId);
    }

    continuation = listResult.IsTruncated
      ? listResult.NextContinuationToken
      : undefined;
  } while (continuation);

  return { debited, refunded };
}

/**
 * Appends a transaction line to the repo's current-month ledger.
 */
async function appendLedgerTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const ledgerPath = createCreditLedgerPath(repoSlug);
  const line = JSON.stringify(transaction) + "\n";

  let existing = "";
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: ledgerPath })
    );
    existing = result.Body ? await result.Body.transformToString() : "";
  } catch (error: any) {
    if (error.name !== "NoSuchKey") throw error;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: ledgerPath,
      Body: existing + line,
      ContentType: "application/json",
    })
  );
}

/**
 * Refunds one task's dispatch-time reservation: credits the balance back and
 * records the refund transaction in the ledger.
 */
async function refundReservation(
  repoSlug: string,
  metadata: TaskMetadata
): Promise<void> {
  const model = (metadata as any).model || "default";
  const cost = getModelCost(model);
  if (cost <= 0) return;

  const balancePath = createCreditBalancePath(repoSlug);
  let balance: CreditBalance | null = null;
  try {
    const objResult = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: balancePath })
    );
    if (objResult.Body) {
      balance = JSON.parse(
        await objResult.Body.transformToString()
      ) as CreditBalance;
    }
  } catch (error: any) {
    if (error.name !== "NoSuchKey") throw error;
  }

  if (balance) {
    balance.current_balance += cost;
    balance.total_spent = Math.max(0, balance.total_spent - cost);
    balance.last_updated = new Date().toISOString();
    balance.version += 1;
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: balancePath,
        Body: JSON.stringify(balance, null, 2),
        ContentType: "application/json",
      })
    );
  }

  await appendLedgerTransaction(repoSlug, {
    timestamp: new Date().toISOString(),
    type: "refund",
    amount: cost,
    reason: `Task ${metadata.task_id} ${metadata.status} — reconciled dispatch-time reservation (no charge for failed tasks)`,
    task_id: metadata.task_id,
    model,
  });

  console.log(
    `Reconciled refund of ${cost} credits to ${repoSlug} for ${metadata.status} task ${metadata.task_id}`
  );
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

    // Refund dispatch-time reservations for failed/timed-out tasks
    const reconciliation = await reconcileCredits();
    console.log(
      `Credit reconciliation: scanned=${reconciliation.scanned} refunded=${reconciliation.refunded} errors=${reconciliation.errors.length}`
    );
    for (const err of reconciliation.errors) {
      console.warn(`Credit reconciliation error: ${err}`);
    }

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
