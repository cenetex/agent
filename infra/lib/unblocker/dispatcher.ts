/**
 * Unblocker Action Dispatcher Lambda
 *
 * Reads the classified snapshot produced by the classifier (sub-issue 2) and
 * takes safe, bounded actions per classification category:
 *
 * | Classification       | Action                                                        |
 * |---------------------|---------------------------------------------------------------|
 * | Fake failure        | After hold period, merge PR if checks green, close issue      |
 * | Transient-retryable | Re-add `agent` label after exponential backoff (max 3 / 24h)  |
 * | CI-real failure     | File tightly-scoped follow-up issue; re-add `agent` label      |
 * | Cascade-duplicate   | Pick best/most-recent representative, close others linking it |
 * | Genuine             | No action — surfaced in daily report only                     |
 *
 * Safety controls (see issue #389):
 * 1. Dry-run mode is the default. Per-repo opt-in via `unblocker:enabled`
 *    label on the repo or `.github/UNBLOCKER.md`.
 * 2. Action budget per run: max 5 auto-merges, 10 label changes, 5 issue
 *    creations. Hard stop if exceeded.
 * 3. Loop detection: same PR/issue passing through the dispatcher >3x in 24h
 *    without progress → escalate (sub-issue 4) and freeze.
 * 4. Hold period: even auto-merges wait the configured hold (default 10 min).
 * 5. Never force-push, override branch protection, modify org settings, or
 *    admin-merge.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { getInstallationToken, type GitHubAppConfig } from "../types";

import {
  fireEscalationHook,
  isEscalated,
  readEscalationQueue,
  type EscalationInput,
} from "./escalation";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const cloudwatch = new CloudWatchClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default hold period before auto-merging a fake-failure PR (minutes). */
const DEFAULT_HOLD_MINUTES = 10;

/** Max auto-merges per dispatcher run. */
const MAX_AUTO_MERGES = 5;

/** Max label changes per dispatcher run. */
const MAX_LABEL_CHANGES = 10;

/** Max issue creations per dispatcher run. */
const MAX_ISSUE_CREATIONS = 5;

/** Max dispatcher passes for the same PR/issue in 24h before loop freeze. */
const LOOP_THRESHOLD = 3;

/** Max retries for transient failures within the 24h window. */
const MAX_TRANSIENT_RETRIES = 3;

/** Exponential backoff base in minutes: 5, 10, 20 (capped at MAX_TRANSIENT_RETRIES). */
const BACKOFF_BASE_MINUTES = 5;

const AGENT_LABEL = "agent";
const UNBLOCKER_ENABLED_LABEL = "unblocker:enabled";

// ---------------------------------------------------------------------------
// Types — classification snapshot (produced by sub-issue 2 classifier)
// ---------------------------------------------------------------------------

export type Classification =
  | "fake_failure"
  | "transient_retryable"
  | "ci_real_failure"
  | "cascade_duplicate"
  | "genuine";

export interface ClassifiedItem {
  /** Repo slug in owner/name format. */
  repo_slug: string;
  /** Issue or PR number. */
  number: number;
  /** True if this item is a PR, false if an issue. */
  is_pr: boolean;
  /** Title of the issue/PR. */
  title: string;
  /** GitHub URL to the issue/PR. */
  github_url: string;
  /** Assigned classification. */
  classification: Classification;
  /** Head SHA for PRs (null for issues). */
  head_sha: string | null;
  /** Whether the PR is mergeable (null for issues). */
  mergeable: boolean | null;
  /** Check-runs summary for PRs. */
  check_runs_summary: {
    total: number;
    failed: number;
    pending: number;
    passed: number;
    failed_checks: string[];
  } | null;
  /** Optional free-text rationale from the classifier. */
  rationale: string | null;
  /** When the item was last updated (ISO 8601). */
  last_updated: string | null;
}

export interface ClassifiedSnapshot {
  /** Snapshot identifier. */
  snapshot_id: string;
  /** ISO 8601 timestamp the snapshot was classified. */
  classified_at: string;
  /** Per-repo classified items. */
  repos: Record<string, { items: ClassifiedItem[] }>;
}

// ---------------------------------------------------------------------------
// Loop tracker (S3)
// ---------------------------------------------------------------------------

interface LoopTrackerEntry {
  repo_slug: string;
  number: number;
  passes: string[];
  frozen: boolean;
}

interface LoopTracker {
  repo_slug: string;
  number: number;
  passes: string[];
  frozen: boolean;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

export interface DispatcherAction {
  repo_slug: string;
  number: number;
  classification: Classification;
  action: string;
  dry_run: boolean;
  success: boolean;
  message: string;
}

export interface DispatcherResult {
  actions: DispatcherAction[];
  counts: Record<Classification, number>;
  budget_exceeded: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      "User-Agent": "github-agent-unblocker-dispatcher",
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

function loopTrackerKey(repoSlug: string, number: number): string {
  return `unblocker/loop-tracker/${repoSlug}/${number}.json`;
}

/**
 * Reads the loop tracker for an item from S3. Returns a fresh entry if none
 * exists yet. Only passes within the last 24h are retained.
 */
export async function readLoopTracker(
  repoSlug: string,
  number: number
): Promise<LoopTrackerEntry> {
  const key = loopTrackerKey(repoSlug, number);
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key })
    );
    if (!result.Body) {
      return { repo_slug: repoSlug, number, passes: [], frozen: false };
    }
    const content = await result.Body.transformToString();
    const parsed = JSON.parse(content) as LoopTracker;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const passes = (parsed.passes ?? []).filter(
      (ts) => new Date(ts).getTime() >= cutoff
    );
    return {
      repo_slug: repoSlug,
      number,
      passes,
      frozen: parsed.frozen ?? false,
    };
  } catch {
    return { repo_slug: repoSlug, number, passes: [], frozen: false };
  }
}

/**
 * Writes the loop tracker back to S3 at
 * `unblocker/loop-tracker/{repo}/{number}.json`.
 */
export async function writeLoopTracker(
  entry: LoopTrackerEntry
): Promise<void> {
  const key = loopTrackerKey(entry.repo_slug, entry.number);
  const body: LoopTracker = {
    repo_slug: entry.repo_slug,
    number: entry.number,
    passes: entry.passes,
    frozen: entry.frozen,
    updated_at: new Date().toISOString(),
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json",
    })
  );
  console.log(`Wrote loop tracker to s3://${ARTIFACTS_BUCKET}/${key}`);
}

/**
 * Records a dispatcher pass for an item and returns whether the item is now
 * frozen (loop detected: > LOOP_THRESHOLD passes in 24h).
 */
export async function recordPass(
  repoSlug: string,
  number: number
): Promise<{ entry: LoopTrackerEntry; frozen: boolean }> {
  const entry = await readLoopTracker(repoSlug, number);
  entry.passes.push(new Date().toISOString());
  const frozen = entry.passes.length > LOOP_THRESHOLD;
  entry.frozen = frozen;
  await writeLoopTracker(entry);
  return { entry, frozen };
}

// ---------------------------------------------------------------------------
// Per-repo enable flag
// ---------------------------------------------------------------------------

/**
 * Determines whether the dispatcher is enabled for a repo. Default is OFF.
 * Opt-in via the `unblocker:enabled` repo label OR `.github/UNBLOCKER.md`.
 */
export async function isRepoEnabled(
  repoSlug: string,
  token: string
): Promise<boolean> {
  // Check for the `unblocker:enabled` label on the repo.
  try {
    const response = await githubRequest(
      `/repos/${repoSlug}/labels/${encodeURIComponent(UNBLOCKER_ENABLED_LABEL)}`,
      token,
      { method: "GET" },
      [200, 404]
    );
    if (response.status === 200) return true;
  } catch (error) {
    console.warn(
      `Failed to check repo label for ${repoSlug}:`,
      error instanceof Error ? error.message : error
    );
  }

  // Check for `.github/UNBLOCKER.md`.
  try {
    const response = await githubRequest(
      `/repos/${repoSlug}/contents/.github/UNBLOCKER.md`,
      token,
      {
        method: "GET",
        headers: { Accept: "application/vnd.github.raw" },
      },
      [200, 404]
    );
    if (response.status === 200) {
      return true;
    }
  } catch (error) {
    console.warn(
      `Failed to check .github/UNBLOCKER.md for ${repoSlug}:`,
      error instanceof Error ? error.message : error
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// Dry-run helpers
// ---------------------------------------------------------------------------

/**
 * In dry-run mode, posts a "would do X" comment on the issue/PR instead of
 * performing the mutation. Returns early if not dry-run.
 */
async function dryRunComment(
  repoSlug: string,
  number: number,
  token: string,
  dryRun: boolean,
  message: string
): Promise<boolean> {
  if (!dryRun) return false;
  const body = `<!-- unblocker-dispatcher dry-run -->\n**Unblocker dispatcher (dry-run)**\n\n${message}`;
  await githubRequest(
    `/repos/${repoSlug}/issues/${number}/comments`,
    token,
    { method: "POST", body: JSON.stringify({ body }) },
    [201]
  );
  return true;
}

// ---------------------------------------------------------------------------
// GitHub action primitives (budgeted)
// ---------------------------------------------------------------------------

interface ActionBudget {
  merges: number;
  labelChanges: number;
  issueCreations: number;
  exceeded: boolean;
}

function freshBudget(): ActionBudget {
  return {
    merges: 0,
    labelChanges: 0,
    issueCreations: 0,
    exceeded: false,
  };
}

async function addLabel(
  repoSlug: string,
  number: number,
  token: string,
  label: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<DispatcherAction | null> {
  if (budget.labelChanges >= MAX_LABEL_CHANGES) {
    budget.exceeded = true;
    return null;
  }
  if (dryRun) {
    budget.labelChanges++;
    return {
      repo_slug: repoSlug,
      number,
      classification: "transient_retryable",
      action: "add_label",
      dry_run: true,
      success: true,
      message: `Would add label \`${label}\` to #${number}`,
    };
  }
  try {
    await githubRequest(
      `/repos/${repoSlug}/issues/${number}/labels`,
      token,
      { method: "POST", body: JSON.stringify({ labels: [label] }) },
      [200, 201]
    );
    budget.labelChanges++;
    return {
      repo_slug: repoSlug,
      number,
      classification: "transient_retryable",
      action: "add_label",
      dry_run: false,
      success: true,
      message: `Added label \`${label}\` to #${number}`,
    };
  } catch (error) {
    return {
      repo_slug: repoSlug,
      number,
      classification: "transient_retryable",
      action: "add_label",
      dry_run: false,
      success: false,
      message: `Failed to add label: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function mergePR(
  repoSlug: string,
  number: number,
  headSha: string | null,
  token: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<DispatcherAction | null> {
  if (budget.merges >= MAX_AUTO_MERGES) {
    budget.exceeded = true;
    return null;
  }
  if (dryRun) {
    budget.merges++;
    return {
      repo_slug: repoSlug,
      number,
      classification: "fake_failure",
      action: "merge_pr",
      dry_run: true,
      success: true,
      message: `Would merge PR #${number}`,
    };
  }
  try {
    const body: Record<string, string> = {
      commit_title: `Auto-merge (unblocker): #${number}`,
      merge_method: "squash",
    };
    if (headSha) body.sha = headSha;
    await githubRequest(
      `/repos/${repoSlug}/pulls/${number}/merge`,
      token,
      { method: "PUT", body: JSON.stringify(body) },
      [200]
    );
    budget.merges++;
    return {
      repo_slug: repoSlug,
      number,
      classification: "fake_failure",
      action: "merge_pr",
      dry_run: false,
      success: true,
      message: `Merged PR #${number}`,
    };
  } catch (error) {
    return {
      repo_slug: repoSlug,
      number,
      classification: "fake_failure",
      action: "merge_pr",
      dry_run: false,
      success: false,
      message: `Failed to merge: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function closeIssue(
  repoSlug: string,
  number: number,
  token: string,
  dryRun: boolean,
  classification: Classification
): Promise<DispatcherAction> {
  if (dryRun) {
    return {
      repo_slug: repoSlug,
      number,
      classification,
      action: "close",
      dry_run: true,
      success: true,
      message: `Would close #${number}`,
    };
  }
  try {
    await githubRequest(
      `/repos/${repoSlug}/issues/${number}`,
      token,
      { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
      [200]
    );
    return {
      repo_slug: repoSlug,
      number,
      classification,
      action: "close",
      dry_run: false,
      success: true,
      message: `Closed #${number}`,
    };
  } catch (error) {
    return {
      repo_slug: repoSlug,
      number,
      classification,
      action: "close",
      dry_run: false,
      success: false,
      message: `Failed to close: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function createFollowUpIssue(
  repoSlug: string,
  title: string,
  body: string,
  token: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<{ action: DispatcherAction; issueNumber: number | null }> {
  if (budget.issueCreations >= MAX_ISSUE_CREATIONS) {
    budget.exceeded = true;
    return {
      action: {
        repo_slug: repoSlug,
        number: 0,
        classification: "ci_real_failure",
        action: "create_issue",
        dry_run: dryRun,
        success: false,
        message: "Issue creation budget exceeded",
      },
      issueNumber: null,
    };
  }
  if (dryRun) {
    budget.issueCreations++;
    return {
      action: {
        repo_slug: repoSlug,
        number: 0,
        classification: "ci_real_failure",
        action: "create_issue",
        dry_run: true,
        success: true,
        message: `Would create follow-up issue: ${title}`,
      },
      issueNumber: null,
    };
  }
  try {
    const response = await githubRequest(
      `/repos/${repoSlug}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ title, body, labels: ["agent"] }),
      },
      [201]
    );
    const data = (await response.json()) as { number: number };
    budget.issueCreations++;
    return {
      action: {
        repo_slug: repoSlug,
        number: data.number,
        classification: "ci_real_failure",
        action: "create_issue",
        dry_run: false,
        success: true,
        message: `Created follow-up issue #${data.number}: ${title}`,
      },
      issueNumber: data.number,
    };
  } catch (error) {
    return {
      action: {
        repo_slug: repoSlug,
        number: 0,
        classification: "ci_real_failure",
        action: "create_issue",
        dry_run: false,
        success: false,
        message: `Failed to create issue: ${error instanceof Error ? error.message : String(error)}`,
      },
      issueNumber: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Action paths per classification
// ---------------------------------------------------------------------------

/**
 * Fake failure: after the hold period, merge the PR if checks are green and
 * close the originating issue.
 */
export async function handleFakeFailure(
  item: ClassifiedItem,
  token: string,
  dryRun: boolean,
  budget: ActionBudget,
  holdMinutes: number
): Promise<DispatcherAction[]> {
  const actions: DispatcherAction[] = [];

  // Only PRs can be merged for fake failures.
  if (!item.is_pr) {
    actions.push({
      repo_slug: item.repo_slug,
      number: item.number,
      classification: "fake_failure",
      action: "noop",
      dry_run: dryRun,
      success: true,
      message: "Fake-failure classification on an issue; no merge action.",
    });
    return actions;
  }

  const checks = item.check_runs_summary;
  const checksGreen =
    checks !== null && checks.failed === 0 && checks.pending === 0 && checks.passed > 0;

  if (!checksGreen) {
    actions.push({
      repo_slug: item.repo_slug,
      number: item.number,
      classification: "fake_failure",
      action: "noop",
      dry_run: dryRun,
      success: true,
      message: "Checks not green; skipping merge for fake failure.",
    });
    return actions;
  }

  // Hold period: require the item to have been idle for the hold window.
  const holdMs = holdMinutes * 60 * 1000;
  const lastUpdated = item.last_updated ? new Date(item.last_updated).getTime() : 0;
  const elapsed = Date.now() - lastUpdated;
  if (elapsed < holdMs) {
    actions.push({
      repo_slug: item.repo_slug,
      number: item.number,
      classification: "fake_failure",
      action: "hold",
      dry_run: dryRun,
      success: true,
      message: `Hold period not yet elapsed (${Math.round(elapsed / 60000)}m / ${holdMinutes}m).`,
    });
    return actions;
  }

  await dryRunComment(
    item.repo_slug,
    item.number,
    token,
    dryRun,
    `Would merge PR #${item.number} (fake failure, checks green) and close the originating issue.`
  );

  const mergeAction = await mergePR(
    item.repo_slug,
    item.number,
    item.head_sha,
    token,
    dryRun,
    budget
  );
  if (mergeAction) actions.push(mergeAction);

  if (mergeAction?.success) {
    actions.push(await closeIssue(item.repo_slug, item.number, token, dryRun, "fake_failure"));
  }

  return actions;
}

/**
 * Transient — retryable: re-add the `agent` label after exponential backoff.
 * Max 3 retries within a 24h window.
 */
export async function handleTransientRetryable(
  item: ClassifiedItem,
  token: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<DispatcherAction[]> {
  const actions: DispatcherAction[] = [];

  // Determine the retry count from the loop tracker passes.
  const tracker = await readLoopTracker(item.repo_slug, item.number);
  const retryCount = tracker.passes.length;

  if (retryCount > MAX_TRANSIENT_RETRIES) {
    actions.push({
      repo_slug: item.repo_slug,
      number: item.number,
      classification: "transient_retryable",
      action: "noop",
      dry_run: dryRun,
      success: true,
      message: `Max transient retries (${MAX_TRANSIENT_RETRIES}) exceeded; escalating.`,
    });
    return actions;
  }

  // Exponential backoff: base * 2^(retryCount-1).
  const backoffMinutes = BACKOFF_BASE_MINUTES * Math.pow(2, Math.max(0, retryCount - 1));
  const backoffMs = backoffMinutes * 60 * 1000;
  const lastPass = tracker.passes[tracker.passes.length - 1];
  const lastPassTime = lastPass ? new Date(lastPass).getTime() : 0;
  const elapsed = Date.now() - lastPassTime;

  if (retryCount > 0 && elapsed < backoffMs) {
    actions.push({
      repo_slug: item.repo_slug,
      number: item.number,
      classification: "transient_retryable",
      action: "backoff",
      dry_run: dryRun,
      success: true,
      message: `Backoff not yet elapsed (${Math.round(elapsed / 60000)}m / ${backoffMinutes}m).`,
    });
    return actions;
  }

  await dryRunComment(
    item.repo_slug,
    item.number,
    token,
    dryRun,
    `Would re-add the \`${AGENT_LABEL}\` label to #${item.number} (transient retryable, retry ${retryCount + 1}/${MAX_TRANSIENT_RETRIES}).`
  );

  const labelAction = await addLabel(
    item.repo_slug,
    item.number,
    token,
    AGENT_LABEL,
    dryRun,
    budget
  );
  if (labelAction) actions.push(labelAction);

  return actions;
}

/**
 * CI-real failure: file a tightly-scoped follow-up issue pointing at the
 * failing checks; re-add `agent` label on the follow-up.
 */
export async function handleCiRealFailure(
  item: ClassifiedItem,
  token: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<DispatcherAction[]> {
  const actions: DispatcherAction[] = [];

  const failedChecks = item.check_runs_summary?.failed_checks ?? [];
  const checksList = failedChecks.length > 0 ? failedChecks.join(", ") : "unknown";
  const issueTitle = `fix: failing CI checks on ${item.is_pr ? "PR" : "issue"} #${item.number}`;
  const issueBody = [
    `## Failing checks`,
    ``,
    `The following CI checks are failing on [${item.is_pr ? "PR" : "issue"} #${item.number}](${item.github_url}):`,
    ``,
    `**Checks:** ${checksList}`,
    ``,
    `This is a tightly-scoped follow-up created by the unblocker dispatcher.`,
    ``,
    `**Classification:** ci_real_failure`,
    `**Rationale:** ${item.rationale ?? "n/a"}`,
  ].join("\n");

  await dryRunComment(
    item.repo_slug,
    item.number,
    token,
    dryRun,
    `Would create a follow-up issue for failing checks (${checksList}) and re-add the \`${AGENT_LABEL}\` label on it.`
  );

  const { action: createAction, issueNumber } = await createFollowUpIssue(
    item.repo_slug,
    issueTitle,
    issueBody,
    token,
    dryRun,
    budget
  );
  actions.push(createAction);

  if (issueNumber) {
    const labelAction = await addLabel(
      item.repo_slug,
      issueNumber,
      token,
      AGENT_LABEL,
      dryRun,
      budget
    );
    if (labelAction) actions.push(labelAction);
  }

  return actions;
}

/**
 * Cascade — duplicate: pick the best/most-recent representative and close the
 * others, linking them to the representative.
 */
export async function handleCascadeDuplicate(
  items: ClassifiedItem[],
  token: string,
  dryRun: boolean,
  budget: ActionBudget
): Promise<DispatcherAction[]> {
  const actions: DispatcherAction[] = [];
  if (items.length <= 1) return actions;

  // Pick the most recently updated item as the representative.
  const sorted = [...items].sort((a, b) => {
    const aTime = a.last_updated ? new Date(a.last_updated).getTime() : 0;
    const bTime = b.last_updated ? new Date(b.last_updated).getTime() : 0;
    return bTime - aTime;
  });
  const representative = sorted[0];
  const duplicates = sorted.slice(1);

  for (const dup of duplicates) {
    await dryRunComment(
      dup.repo_slug,
      dup.number,
      token,
      dryRun,
      `Would close #${dup.number} as a duplicate of ${representative.github_url} (cascade duplicate).`
    );

    // Post a linking comment before closing.
    if (!dryRun) {
      try {
        await githubRequest(
          `/repos/${dup.repo_slug}/issues/${dup.number}/comments`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              body: `Closing as duplicate of ${representative.github_url} (unblocker cascade-duplicate).`,
            }),
          },
          [201]
        );
      } catch (error) {
        console.warn(
          `Failed to post duplicate-link comment on #${dup.number}:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    actions.push(await closeIssue(dup.repo_slug, dup.number, token, dryRun, "cascade_duplicate"));
  }

  return actions;
}

/**
 * Genuine: no action — surfaced in the daily report only.
 */
export function handleGenuine(
  item: ClassifiedItem,
  dryRun: boolean
): DispatcherAction {
  return {
    repo_slug: item.repo_slug,
    number: item.number,
    classification: "genuine",
    action: "noop",
    dry_run: dryRun,
    success: true,
    message: "Genuine failure; no action, surfaced in daily report only.",
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export async function publishMetrics(
  counts: Record<Classification, number>
): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "UnblockerDispatcher",
        MetricData: (Object.keys(counts) as Classification[]).map((category) => ({
          MetricName: "ActionsByCategory",
          Dimensions: [{ Name: "Classification", Value: category }],
          Value: counts[category],
          Unit: "Count",
          Timestamp: new Date(),
        })),
      })
    );
    console.log("Published UnblockerDispatcher.ActionsByCategory metrics");
  } catch (error) {
    console.error("Failed to publish CloudWatch metric:", error);
  }
}

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

export async function loadClassifiedSnapshot(): Promise<ClassifiedSnapshot> {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: "unblocker/classified/latest.json",
    })
  );
  if (!result.Body) {
    throw new Error("Classified snapshot body is empty");
  }
  const content = await result.Body.transformToString();
  return JSON.parse(content) as ClassifiedSnapshot;
}

// ---------------------------------------------------------------------------
// Main dispatch logic
// ---------------------------------------------------------------------------

/**
 * Processes a single classified item, returning the actions taken. Handles
 * loop detection and per-repo enable checks.
 */
export async function dispatchItem(
  item: ClassifiedItem,
  token: string,
  dryRun: boolean,
  budget: ActionBudget,
  holdMinutes: number
): Promise<DispatcherAction[]> {
  // Skip items already in the escalated state — the dispatcher ignores
  // them until either (a) human action moves the underlying issue out of
  // `agent:failed`, or (b) the human removes the escalation by editing the
  // pinned issue body (which marks the entry as resolved).
  const escalationQueue = await readEscalationQueue();
  if (isEscalated(escalationQueue, item.repo_slug, item.number)) {
    return [
      {
        repo_slug: item.repo_slug,
        number: item.number,
        classification: item.classification,
        action: "skip_escalated",
        dry_run: dryRun,
        success: true,
        message: "Item is in escalated state; skipping until human action resolves it.",
      },
    ];
  }

  // Loop detection: record this pass and freeze if threshold exceeded.
  const { frozen } = await recordPass(item.repo_slug, item.number);
  if (frozen) {
    // Fire the escalation hook (sub-issue 4): adds the item to the pinned
    // "Unblocker Escalations" issue, fires the webhook if configured, and
    // persists the queue so subsequent runs skip it.
    const escalationInput: EscalationInput = {
      repo_slug: item.repo_slug,
      number: item.number,
      is_pr: item.is_pr,
      github_url: item.github_url,
      root_cause_hypothesis: item.rationale ?? "Unknown — loop detected without progress.",
      what_was_tried: `Dispatcher tried ${LOOP_THRESHOLD}+ times in 24h without progress (classification: ${item.classification}).`,
      recommended_action: "Investigate the root cause; the dispatcher will not retry until resolved.",
      last_attempt_count: LOOP_THRESHOLD,
    };
    try {
      await fireEscalationHook(escalationInput);
    } catch (error) {
      console.error("Escalation hook failed:", error);
    }
    return [
      {
        repo_slug: item.repo_slug,
        number: item.number,
        classification: item.classification,
        action: "freeze",
        dry_run: dryRun,
        success: true,
        message: `Loop detected (> ${LOOP_THRESHOLD} passes in 24h); freezing and escalating.`,
      },
    ];
  }

  switch (item.classification) {
    case "fake_failure":
      return handleFakeFailure(item, token, dryRun, budget, holdMinutes);
    case "transient_retryable":
      return handleTransientRetryable(item, token, dryRun, budget);
    case "ci_real_failure":
      return handleCiRealFailure(item, token, dryRun, budget);
    case "cascade_duplicate":
      // Handled in batch per repo (see dispatchSnapshot), no-op here.
      return [
        {
          repo_slug: item.repo_slug,
          number: item.number,
          classification: "cascade_duplicate",
          action: "noop",
          dry_run: dryRun,
          success: true,
          message: "Cascade-duplicate handled in batch.",
        },
      ];
    case "genuine":
      return [handleGenuine(item, dryRun)];
    default:
      return [
        {
          repo_slug: item.repo_slug,
          number: item.number,
          classification: item.classification,
          action: "noop",
          dry_run: dryRun,
          success: true,
          message: `Unknown classification: ${item.classification}`,
        },
      ];
  }
}

/**
 * Processes the full classified snapshot. This is the pure dispatching logic
 * that is unit-tested with a mocked GitHub API / S3.
 */
export async function dispatchSnapshot(
  snapshot: ClassifiedSnapshot,
  tokenResolver: (repoSlug: string) => Promise<string>,
  enableResolver: (repoSlug: string, token: string) => Promise<boolean>,
  holdMinutes: number = DEFAULT_HOLD_MINUTES
): Promise<DispatcherResult> {
  const actions: DispatcherAction[] = [];
  const counts: Record<Classification, number> = {
    fake_failure: 0,
    transient_retryable: 0,
    ci_real_failure: 0,
    cascade_duplicate: 0,
    genuine: 0,
  };
  const budget = freshBudget();

  for (const [repoSlug, repoData] of Object.entries(snapshot.repos)) {
    if (budget.exceeded) {
      console.warn("Action budget exceeded; hard stop.");
      break;
    }

    const token = await tokenResolver(repoSlug);
    const enabled = await enableResolver(repoSlug, token);

    // Dry-run is the default; only mutate when the repo is opted in.
    const dryRun = !enabled;

    const items = repoData.items ?? [];

    // Separate cascade-duplicate items for batch processing.
    const cascadeItems = items.filter((i) => i.classification === "cascade_duplicate");
    const otherItems = items.filter((i) => i.classification !== "cascade_duplicate");

    for (const item of otherItems) {
      const itemActions = await dispatchItem(item, token, dryRun, budget, holdMinutes);
      actions.push(...itemActions);
      counts[item.classification] += itemActions.filter((a) => a.success && a.action !== "noop" && a.action !== "hold" && a.action !== "backoff" && a.action !== "freeze").length;
    }

    // Cascade duplicates: group and pick a representative.
    if (cascadeItems.length > 1) {
      const cascadeActions = await handleCascadeDuplicate(cascadeItems, token, dryRun, budget);
      actions.push(...cascadeActions);
      counts.cascade_duplicate += cascadeActions.filter((a) => a.success && a.action !== "noop").length;
    } else if (cascadeItems.length === 1) {
      const single = cascadeItems[0];
      actions.push({
        repo_slug: single.repo_slug,
        number: single.number,
        classification: "cascade_duplicate",
        action: "noop",
        dry_run: dryRun,
        success: true,
        message: "Single cascade-duplicate item; nothing to close.",
      });
    }
  }

  await publishMetrics(counts);

  return { actions, counts, budget_exceeded: budget.exceeded };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export async function handler(): Promise<void> {
  console.log("Starting unblocker action dispatcher...");

  try {
    const snapshot = await loadClassifiedSnapshot();

    const appId = await getParameter(GITHUB_APP_ID_PARAM);
    const privateKey = await getParameter(GITHUB_APP_PRIVATE_KEY_PARAM);
    const appConfig: GitHubAppConfig = { appId, privateKey };

    const holdMinutes = process.env.UNBLOCKER_HOLD_MINUTES
      ? parseInt(process.env.UNBLOCKER_HOLD_MINUTES, 10)
      : DEFAULT_HOLD_MINUTES;

    const tokenResolver = async (repoSlug: string): Promise<string> => {
      const [owner, name] = repoSlug.split("/");
      return getInstallationToken(owner, name, appConfig);
    };

    const result = await dispatchSnapshot(
      snapshot,
      tokenResolver,
      isRepoEnabled,
      holdMinutes
    );

    console.log(
      `Dispatcher completed. ${result.actions.length} actions, budget exceeded: ${result.budget_exceeded}`
    );
    console.log("Counts:", JSON.stringify(result.counts));
  } catch (error) {
    console.error("Dispatcher failed:", error);
    throw error;
  }
}
