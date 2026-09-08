/**
 * Unblocker Escalation Queue (sub-issue 4 of #316)
 *
 * When the dispatcher's loop detection fires (same item >3x in 24h, no
 * progress) or a Genuine classification persists across 3 daily reports,
 * the item is escalated to humans rather than silently retried forever.
 *
 * Escalation surface:
 * - A single pinned issue per repo (or per org, configurable) titled
 *   "Unblocker Escalations" — re-used, never closed. Its body lists
 *   current escalations with: item link, root-cause hypothesis, what was
 *   tried, recommended human action.
 * - An optional webhook (UNBLOCKER_ESCALATION_WEBHOOK env var) that
 *   receives a JSON payload if set and no-ops if not.
 * - The daily health report gains an "Escalations" section linking the
 *   pinned issue and listing escalated items.
 *
 * The pinned issue body contains a machine-parseable section delimited by
 * `<!-- unblocker:escalations:start -->` / `<!-- unblocker:escalations:end -->`
 * so the dispatcher can read prior escalations and skip items already
 * escalated.
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
import type { GitHubAppConfig } from "../types";
import { getInstallationToken } from "../types";
import type {
  EscalationEntry,
  EscalationQueue,
  EscalationWebhookPayload,
} from "./types";

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Title of the pinned escalation issue (re-used, never closed). */
const ESCALATION_ISSUE_TITLE = "Unblocker Escalations";

/** Labels applied to the pinned escalation issue. */
const ESCALATION_ISSUE_LABELS = ["unblocker:escalations", "pinned"];

/** Max attempts before an item enters the escalated state (configurable). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Max days an escalation can remain unresolved before nag-boosting. */
const NAG_AFTER_DAYS = 7;

/** S3 key for the persisted escalation queue. */
const ESCALATION_QUEUE_KEY = "unblocker/escalations/queue.json";

// ---------------------------------------------------------------------------
// Machine-parseable section markers
// ---------------------------------------------------------------------------

export const ESCALATION_SECTION_START = "<!-- unblocker:escalations:start -->";
export const ESCALATION_SECTION_END = "<!-- unblocker:escalations:end -->";

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
      "User-Agent": "github-agent-unblocker-escalation",
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

function entryKey(repoSlug: string, number: number): string {
  return `${repoSlug}#${number}`;
}

// ---------------------------------------------------------------------------
// Queue persistence (S3)
// ---------------------------------------------------------------------------

/**
 * Reads the escalation queue from S3. Returns an empty queue if none
 * exists yet.
 */
export async function readEscalationQueue(): Promise<EscalationQueue> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: ESCALATION_QUEUE_KEY })
    );
    if (!result.Body) {
      return { entries: [], pinned_issue_number: null, updated_at: new Date().toISOString() };
    }
    const content = await result.Body.transformToString();
    const parsed = JSON.parse(content) as EscalationQueue;
    return {
      entries: parsed.entries ?? [],
      pinned_issue_number: parsed.pinned_issue_number ?? null,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
    };
  } catch {
    return { entries: [], pinned_issue_number: null, updated_at: new Date().toISOString() };
  }
}

/**
 * Writes the escalation queue back to S3.
 */
export async function writeEscalationQueue(
  queue: EscalationQueue
): Promise<void> {
  const body: EscalationQueue = {
    entries: queue.entries,
    pinned_issue_number: queue.pinned_issue_number,
    updated_at: new Date().toISOString(),
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: ESCALATION_QUEUE_KEY,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json",
    })
  );
  console.log(`Wrote escalation queue to s3://${ARTIFACTS_BUCKET}/${ESCALATION_QUEUE_KEY}`);
}

// ---------------------------------------------------------------------------
// Core queue logic (pure & testable)
// ---------------------------------------------------------------------------

/**
 * Checks whether an item is already escalated in the queue.
 */
export function isEscalated(
  queue: EscalationQueue,
  repoSlug: string,
  number: number
): boolean {
  return queue.entries.some(
    (e) =>
      e.repo_slug === repoSlug &&
      e.number === number &&
      e.state === "escalated"
  );
}

/**
 * Checks whether an item has an escalation entry (escalated or resolved).
 */
export function hasEscalationEntry(
  queue: EscalationQueue,
  repoSlug: string,
  number: number
): boolean {
  return queue.entries.some(
    (e) => e.repo_slug === repoSlug && e.number === number
  );
}

/**
 * Adds an item to the escalation queue if it is not already present (and
 * not already resolved). Returns the updated queue and the entry that was
 * added (or the existing one if already present).
 */
export function addEscalation(
  queue: EscalationQueue,
  entry: Omit<EscalationEntry, "escalated_at" | "state"> & { escalated_at?: string }
): { queue: EscalationQueue; entry: EscalationEntry; added: boolean } {
  if (isEscalated(queue, entry.repo_slug, entry.number)) {
    const existing = queue.entries.find(
      (e) =>
        e.repo_slug === entry.repo_slug &&
        e.number === entry.number &&
        e.state === "escalated"
    )!;
    return { queue, entry: existing, added: false };
  }

  const newEntry: EscalationEntry = {
    ...entry,
    escalated_at: entry.escalated_at ?? new Date().toISOString(),
    state: "escalated",
  };

  // Remove any prior resolved entry for the same item before re-escalating.
  const filtered = queue.entries.filter(
    (e) => !(e.repo_slug === entry.repo_slug && e.number === entry.number)
  );

  return {
    queue: {
      ...queue,
      entries: [...filtered, newEntry],
      updated_at: new Date().toISOString(),
    },
    entry: newEntry,
    added: true,
  };
}

/**
 * Marks an escalation as resolved (e.g., human action moved the underlying
 * issue out of `agent:failed`, or the human removed the entry from the
 * pinned issue body). Returns the updated queue.
 */
export function resolveEscalation(
  queue: EscalationQueue,
  repoSlug: string,
  number: number
): EscalationQueue {
  return {
    ...queue,
    entries: queue.entries.map((e) =>
      e.repo_slug === repoSlug && e.number === number
        ? { ...e, state: "resolved" as const }
        : e
    ),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Removes resolved escalations that are older than NAG_AFTER_DAYS from the
 * queue (housekeeping). Returns the pruned queue.
 */
export function pruneResolved(
  queue: EscalationQueue,
  now: Date = new Date()
): EscalationQueue {
  const cutoff = now.getTime() - NAG_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return {
    ...queue,
    entries: queue.entries.filter((e) => {
      if (e.state !== "resolved") return true;
      const resolvedAt = new Date(e.escalated_at).getTime();
      return resolvedAt >= cutoff;
    }),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Returns escalations that have been unresolved for longer than
 * NAG_AFTER_DAYS (for the daily report's nag section).
 */
export function getOverdueEscalations(
  queue: EscalationQueue,
  now: Date = new Date()
): EscalationEntry[] {
  const cutoff = now.getTime() - NAG_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return queue.entries.filter(
    (e) => e.state === "escalated" && new Date(e.escalated_at).getTime() < cutoff
  );
}

// ---------------------------------------------------------------------------
// Genuine persistence detection
// ---------------------------------------------------------------------------

/**
 * Threshold for consecutive daily reports in which a Genuine item must
 * appear before it is escalated.
 */
const GENUINE_PERSISTENCE_THRESHOLD = 3;

export interface GenuinePersistence {
  repo_slug: string;
  number: number;
  is_pr: boolean;
  consecutive_reports: number;
}

/**
 * Computes which Genuine items have persisted across >= threshold daily
 * reports and should be escalated.
 *
 * @param currentItems  The items in today's report.
 * @param previousReports  Items from previous daily reports (oldest first).
 * @param threshold       Minimum consecutive reports to trigger escalation.
 */
export function computeGenuinePersisting(
  currentItems: Array<{ repo_slug: string; number: number; is_pr: boolean; category: string }>,
  previousReports: Array<Array<{ repo_slug: string; number: number; is_pr: boolean; category: string }>>,
  threshold: number = GENUINE_PERSISTENCE_THRESHOLD
): GenuinePersistence[] {
  const allReports = [currentItems, ...previousReports];
  const counts = new Map<string, number>();

  for (const report of allReports) {
    for (const item of report) {
      if (item.category !== "genuine") continue;
      const key = `${item.repo_slug}#${item.number}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const result: GenuinePersistence[] = [];
  for (const item of currentItems) {
    if (item.category !== "genuine") continue;
    const key = `${item.repo_slug}#${item.number}`;
    const count = counts.get(key) ?? 0;
    if (count >= threshold) {
      result.push({
        repo_slug: item.repo_slug,
        number: item.number,
        is_pr: item.is_pr,
        consecutive_reports: count,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pinned issue management (GitHub)
// ---------------------------------------------------------------------------

/**
 * Finds the pinned "Unblocker Escalations" issue for a repo by searching
 * for open issues with the escalation label. Returns the issue number or
 * null if not found.
 */
export async function findPinnedIssue(
  repoSlug: string,
  token: string
): Promise<number | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoSlug}/issues?labels=${encodeURIComponent(ESCALATION_ISSUE_LABELS[0])}&state=all&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );
    const issues = (await response.json()) as Array<{ number: number; title: string; state: string }>;
    const match = issues.find(
      (issue) => issue.title === ESCALATION_ISSUE_TITLE
    );
    return match?.number ?? null;
  } catch (error) {
    console.warn(
      `Failed to find pinned escalation issue for ${repoSlug}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Creates the pinned "Unblocker Escalations" issue. Returns the issue
 * number or null on failure.
 */
export async function createPinnedIssue(
  repoSlug: string,
  token: string
): Promise<number | null> {
  try {
    const body = renderPinnedIssueBody({ entries: [], pinned_issue_number: null, updated_at: new Date().toISOString() });
    const response = await githubRequest(
      `/repos/${repoSlug}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: ESCALATION_ISSUE_TITLE,
          body,
          labels: ESCALATION_ISSUE_LABELS,
        }),
      },
      [201]
    );
    const data = (await response.json()) as { number: number };
    console.log(`Created pinned escalation issue #${data.number} in ${repoSlug}`);
    return data.number;
  } catch (error) {
    console.error(
      `Failed to create pinned escalation issue for ${repoSlug}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Ensures the pinned issue exists for a repo, creating it if needed.
 * Returns the issue number or null on failure.
 */
export async function ensurePinnedIssue(
  repoSlug: string,
  token: string
): Promise<number | null> {
  const existing = await findPinnedIssue(repoSlug, token);
  if (existing !== null) return existing;
  return createPinnedIssue(repoSlug, token);
}

/**
 * Reads the pinned issue body and parses the machine-readable escalation
 * section. Returns the entries found in the body or an empty array if
 * the section is missing or unparseable.
 */
export function parsePinnedIssueBody(body: string): EscalationEntry[] {
  const startIdx = body.indexOf(ESCALATION_SECTION_START);
  const endIdx = body.indexOf(ESCALATION_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];

  const section = body.slice(startIdx + ESCALATION_SECTION_START.length, endIdx).trim();
  try {
    const parsed = JSON.parse(section);
    if (Array.isArray(parsed)) return parsed as EscalationEntry[];
    if (parsed && Array.isArray((parsed as { entries?: EscalationEntry[] }).entries))
      return (parsed as { entries: EscalationEntry[] }).entries;
    return [];
  } catch {
    return [];
  }
}

/**
 * Renders the pinned issue body with the current escalation entries.
 * The machine-parseable section is between the start/end markers and
 * contains a JSON array of active entries.
 */
export function renderPinnedIssueBody(queue: EscalationQueue): string {
  const activeEntries = queue.entries.filter((e) => e.state === "escalated");
  const jsonSection = JSON.stringify(activeEntries, null, 2);

  const humanLines: string[] = [
    `# ${ESCALATION_ISSUE_TITLE}`,
    "",
    "> This issue is auto-maintained by the unblocker escalation queue.",
    "> Do **not** close it. Items listed below have exceeded the retry",
    "> threshold and need human attention.",
    "",
    `**Last updated:** ${queue.updated_at}`,
    "",
    "## Current escalations",
    "",
  ];

  if (activeEntries.length === 0) {
    humanLines.push("_No active escalations._");
  } else {
    for (const entry of activeEntries) {
      const itemType = entry.is_pr ? "PR" : "Issue";
      humanLines.push(`### ${itemType} #${entry.number} — [link](${entry.github_url})`);
      humanLines.push("");
      humanLines.push(`- **Repo:** ${entry.repo_slug}`);
      humanLines.push(`- **Root-cause hypothesis:** ${entry.root_cause_hypothesis}`);
      humanLines.push(`- **What was tried:** ${entry.what_was_tried}`);
      humanLines.push(`- **Recommended human action:** ${entry.recommended_action}`);
      humanLines.push(`- **Escalated at:** ${entry.escalated_at}`);
      humanLines.push(`- **Attempt count:** ${entry.last_attempt_count}`);
      humanLines.push("");
    }
  }

  humanLines.push("");
  humanLines.push("---");
  humanLines.push("");
  humanLines.push(ESCALATION_SECTION_START);
  humanLines.push(jsonSection);
  humanLines.push(ESCALATION_SECTION_END);
  humanLines.push("");

  return humanLines.join("\n");
}

/**
 * Updates the pinned issue body with the current escalation queue.
 */
export async function updatePinnedIssueBody(
  repoSlug: string,
  issueNumber: number,
  queue: EscalationQueue,
  token: string
): Promise<void> {
  const body = renderPinnedIssueBody(queue);
  try {
    await githubRequest(
      `/repos/${repoSlug}/issues/${issueNumber}`,
      token,
      { method: "PATCH", body: JSON.stringify({ body }) },
      [200]
    );
    console.log(`Updated pinned escalation issue #${issueNumber} in ${repoSlug}`);
  } catch (error) {
    console.error(
      `Failed to update pinned escalation issue #${issueNumber} in ${repoSlug}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Reads the pinned issue body from GitHub and syncs the in-memory queue
 * with the machine-parseable section. Escalated items that a human
 * removed from the body are marked as resolved.
 */
export async function syncQueueFromPinnedIssue(
  queue: EscalationQueue,
  repoSlug: string,
  issueNumber: number,
  token: string
): Promise<EscalationQueue> {
  try {
    const response = await githubRequest(
      `/repos/${repoSlug}/issues/${issueNumber}`,
      token,
      { method: "GET" },
      [200]
    );
    const data = (await response.json()) as { body: string };
    const bodyEntries = parsePinnedIssueBody(data.body ?? "");

    // Items in the queue that are no longer in the pinned body and were
    // escalated are considered resolved (human removed them).
    const bodyKeys = new Set(bodyEntries.map((e) => entryKey(e.repo_slug, e.number)));
    const synced = queue.entries.map((e) => {
      if (e.state === "escalated" && !bodyKeys.has(entryKey(e.repo_slug, e.number))) {
        return { ...e, state: "resolved" as const };
      }
      return e;
    });

    return {
      ...queue,
      entries: synced,
      updated_at: new Date().toISOString(),
    };
  } catch (error) {
    console.warn(
      `Failed to sync queue from pinned issue #${issueNumber}:`,
      error instanceof Error ? error.message : error
    );
    return queue;
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * Sends an escalation payload to the webhook configured via
 * `UNBLOCKER_ESCALATION_WEBHOOK`. If the env var is not set, this is a
 * no-op. Returns true if the webhook was called (and succeeded), false
 * otherwise.
 */
export async function sendEscalationWebhook(
  payload: EscalationWebhookPayload
): Promise<boolean> {
  const webhookUrl = process.env.UNBLOCKER_ESCALATION_WEBHOOK;
  if (!webhookUrl) {
    console.log("No UNBLOCKER_ESCALATION_WEBHOOK set; skipping webhook.");
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(
        `Escalation webhook returned ${response.status}: ${await response.text()}`
      );
      return false;
    }

    console.log("Escalation webhook sent successfully.");
    return true;
  } catch (error) {
    console.error(
      "Failed to send escalation webhook:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Top-level escalation flow
// ---------------------------------------------------------------------------

export interface EscalationInput {
  repo_slug: string;
  number: number;
  is_pr: boolean;
  github_url: string;
  root_cause_hypothesis: string;
  what_was_tried: string;
  recommended_action: string;
  last_attempt_count: number;
}

/**
 * Escalates a single item: adds it to the queue, ensures the pinned
 * issue exists, updates the pinned issue body, and fires the webhook.
 *
 * Returns the updated queue and whether the item was newly added.
 */
export async function escalateItem(
  queue: EscalationQueue,
  input: EscalationInput,
  tokenResolver: (repoSlug: string) => Promise<string>
): Promise<{ queue: EscalationQueue; added: boolean; pinned_issue_number: number | null }> {
  // Skip if already escalated (dispatcher reads prior escalations and
  // skips already-escalated items).
  if (isEscalated(queue, input.repo_slug, input.number)) {
    return { queue, added: false, pinned_issue_number: queue.pinned_issue_number };
  }

  const { queue: updatedQueue, entry, added } = addEscalation(queue, {
    repo_slug: input.repo_slug,
    number: input.number,
    is_pr: input.is_pr,
    github_url: input.github_url,
    root_cause_hypothesis: input.root_cause_hypothesis,
    what_was_tried: input.what_was_tried,
    recommended_action: input.recommended_action,
    last_attempt_count: input.last_attempt_count,
  });

  if (!added) {
    return { queue: updatedQueue, added: false, pinned_issue_number: updatedQueue.pinned_issue_number };
  }

  // Ensure pinned issue exists and update its body.
  const token = await tokenResolver(input.repo_slug);
  const pinnedNumber = await ensurePinnedIssue(input.repo_slug, token);
  if (pinnedNumber !== null) {
    updatedQueue.pinned_issue_number = pinnedNumber;
    await updatePinnedIssueBody(input.repo_slug, pinnedNumber, updatedQueue, token);
  }

  // Fire webhook.
  await sendEscalationWebhook({
    repo_slug: entry.repo_slug,
    number: entry.number,
    is_pr: entry.is_pr,
    github_url: entry.github_url,
    root_cause_hypothesis: entry.root_cause_hypothesis,
    what_was_tried: entry.what_was_tried,
    recommended_action: entry.recommended_action,
    escalated_at: entry.escalated_at,
    attempt_count: entry.last_attempt_count,
    escalation_issue_url:
      pinnedNumber !== null
        ? `https://github.com/${input.repo_slug}/issues/${pinnedNumber}`
        : null,
  });

  await writeEscalationQueue(updatedQueue);

  return { queue: updatedQueue, added: true, pinned_issue_number: pinnedNumber };
}

/**
 * The main escalation hook called by the dispatcher when the loop
 * threshold is hit. Reads the queue from S3, escalates the item, and
 * writes the queue back. Returns whether the item was escalated.
 */
export async function fireEscalationHook(
  input: EscalationInput
): Promise<boolean> {
  const queue = await readEscalationQueue();

  // Sync with the pinned issue body so we don't re-escalate items a
  // human already resolved by editing the body.
  if (queue.pinned_issue_number !== null) {
    const appId = await getParameter(GITHUB_APP_ID_PARAM);
    const privateKey = await getParameter(GITHUB_APP_PRIVATE_KEY_PARAM);
    const appConfig: GitHubAppConfig = { appId, privateKey };
    const [owner, name] = input.repo_slug.split("/");
    const token = await getInstallationToken(owner, name, appConfig);
    const synced = await syncQueueFromPinnedIssue(
      queue,
      input.repo_slug,
      queue.pinned_issue_number,
      token
    );
    Object.assign(queue, synced);
  }

  const tokenResolver = async (repoSlug: string): Promise<string> => {
    const appId = await getParameter(GITHUB_APP_ID_PARAM);
    const privateKey = await getParameter(GITHUB_APP_PRIVATE_KEY_PARAM);
    const appConfig: GitHubAppConfig = { appId, privateKey };
    const [owner, name] = repoSlug.split("/");
    return getInstallationToken(owner, name, appConfig);
  };

  const { added } = await escalateItem(queue, input, tokenResolver);
  return added;
}

// ---------------------------------------------------------------------------
// Daily report integration
// ---------------------------------------------------------------------------

/**
 * Returns the URL of the pinned escalation issue for a repo, or null if
 * no pinned issue exists.
 */
export function getPinnedIssueUrl(
  queue: EscalationQueue,
  repoSlug: string
): string | null {
  if (queue.pinned_issue_number === null) return null;
  return `https://github.com/${repoSlug}/issues/${queue.pinned_issue_number}`;
}

/**
 * Renders the escalation section for the daily health report markdown.
 * Links the pinned issue and lists current escalations, with overdue
 * items nagged at the top with severity.
 */
export function renderEscalationSection(
  queue: EscalationQueue,
  repoSlug: string
): string {
  const activeEscalations = queue.entries.filter((e) => e.state === "escalated");
  if (activeEscalations.length === 0 && queue.pinned_issue_number === null) {
    return "";
  }

  const lines: string[] = [];
  lines.push("## Escalations");
  lines.push("");

  const overdue = getOverdueEscalations(queue);
  if (overdue.length > 0) {
    lines.push(
      `> ⚠️ **${overdue.length} escalation(s) unresolved for >${NAG_AFTER_DAYS} days — needs immediate attention.**`
    );
    lines.push("");
    for (const entry of overdue) {
      const itemType = entry.is_pr ? "PR" : "Issue";
      lines.push(
        `- 🔴 **${itemType} [#${entry.number}](${entry.github_url})** in ${entry.repo_slug} — escalated ${entry.escalated_at}`
      );
    }
    lines.push("");
  }

  const pinnedUrl = getPinnedIssueUrl(queue, repoSlug);
  if (pinnedUrl) {
    lines.push(`**Pinned escalation issue:** [${ESCALATION_ISSUE_TITLE}](${pinnedUrl})`);
    lines.push("");
  }

  if (activeEscalations.length > 0) {
    lines.push("| Repo | Item | Root cause | Recommended action | Escalated |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const entry of activeEscalations) {
      const itemType = entry.is_pr ? "PR" : "Issue";
      lines.push(
        `| ${entry.repo_slug} | ${itemType} [#${entry.number}](${entry.github_url}) | ${entry.root_cause_hypothesis} | ${entry.recommended_action} | ${entry.escalated_at} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
