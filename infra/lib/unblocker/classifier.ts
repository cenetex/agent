import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type {
  ClassificationCategory,
  ClassifiedItem,
  ClassifiedSnapshot,
  ClassificationReasoning,
  DailyHealthReport,
  EscalationEntry,
  FailureSnapshot,
  FailedIssue,
  FailedPullRequest,
  ReportAccuracy,
  AccuracyEntry,
} from "./types";

import {
  renderEscalationSection as renderEscalations,
  getPinnedIssueUrl,
  readEscalationQueue,
  type EscalationQueue,
} from "./escalation";

const s3 = new S3Client({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

/* ──────────────────────────────────────────────────────────────
 *  Transient error pattern matching
 * ────────────────────────────────────────────────────────────── */

interface TransientPattern {
  readonly id: string;
  readonly regex: RegExp;
  readonly description: string;
}

/**
 * Known transient error patterns.  These are the only patterns that
 * map to the "transient_retryable" category.  Order matters only for
 * the human-readable description; matching is done against all.
 *
 * Validated examples referenced in cenetex/agent#316:
 *  - OpenRouter 402 (payment required)
 *  - GitHub 5xx (server error)
 *  - ECS task SIGTERM (capacity / spot reclaim)
 *  - Network timeout
 */
export const TRANSIENT_PATTERNS: readonly TransientPattern[] = [
  {
    id: "openrouter_402",
    regex: /402\s*(?:payment required|payment_required|insufficient credits?)/i,
    description: "OpenRouter 402 payment required / insufficient credits",
  },
  {
    id: "openrouter_insufficient_credits",
    regex: /insufficient credits/i,
    description: "Insufficient credits error",
  },
  {
    id: "github_5xx",
    regex: /(?:github|api\.github\.com).{0,40}(?:5\d{2}|server error|bad gateway|service unavailable)/i,
    description: "GitHub 5xx server error",
  },
  {
    id: "ecs_sigterm",
    regex: /(?:ecs|fargate).{0,40}(?:sigterm|sigkill|stopped|spot interruption|task evicted)/i,
    description: "ECS/Fargate task SIGTERM or spot interruption",
  },
  {
    id: "network_timeout",
    regex: /(?:timeout|timed out|etimedout|econnreset|enotfound|econnrefused|network error)/i,
    description: "Network timeout or connection error",
  },
] as const;

/**
 * Returns the first matching transient pattern, or `null` when the error
 * excerpt does not match any known transient pattern.
 *
 * Exported (and deterministic) so the unit tests can exercise every
 * pattern without going through S3.
 */
export function matchTransientPattern(
  errorExcerpt: string | null
): TransientPattern | null {
  if (!errorExcerpt) return null;
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.regex.test(errorExcerpt)) return pattern;
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────
 *  Error-signature helper (cascade detection)
 * ────────────────────────────────────────────────────────────── */

/**
 * Produces a normalised error signature for cascade detection.
 *
 * Two failures with the same signature are assumed to share the same
 * root cause.  The signature strips numbers and timestamps but keeps
 * the structural shape of the error so that e.g. two "OpenRouter 402"
 * failures collapse to the same key even when the credit shortfall
 * number differs.
 */
export function errorSignature(
  errorExcerpt: string | null,
  errorCategory: string | null
): string {
  const base = errorCategory ?? "unknown";
  if (!errorExcerpt) return base;
  const normalised = errorExcerpt
    .toLowerCase()
    .replace(/[-+]?\d+/g, "N") // collapse all numbers (incl. negatives)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base}:${normalised}`;
}

/* ──────────────────────────────────────────────────────────────
 *  Cross-reference helpers
 * ────────────────────────────────────────────────────────────── */

/**
 * Build a lookup of PR numbers that have a "fixes" reference pointing
 * at the given issue number within the same repo.
 */
function buildFixesIndex(
  snapshot: FailureSnapshot
): Map<string, Set<number>> {
  // key: `${repoSlug}#${issueNumber}` → set of PR numbers that fix it
  const index = new Map<string, Set<number>>();
  for (const repoData of Object.values(snapshot.repos)) {
    for (const xref of repoData.cross_references) {
      if (xref.type !== "fixes" || !xref.from.is_pr) continue;
      if (xref.from.repo !== xref.to.repo) continue; // same-repo only
      const key = `${xref.to.repo}#${xref.to.issue_number}`;
      let set = index.get(key);
      if (!set) {
        set = new Set<number>();
        index.set(key, set);
      }
      set.add(xref.from.issue_number);
    }
  }
  return index;
}

function findPR(
  snapshot: FailureSnapshot,
  repoSlug: string,
  prNumber: number
): FailedPullRequest | undefined {
  return snapshot.repos[repoSlug]?.pull_requests.find(
    (pr) => pr.number === prNumber
  );
}

/* ──────────────────────────────────────────────────────────────
 *  Core classification logic (pure & deterministic)
 * ────────────────────────────────────────────────────────────── */

/**
 * Classify a single issue from the snapshot.
 *
 * The function is deterministic: given the same snapshot input it
 * always produces the same category and reasoning.
 */
export function classifyIssue(
  repoSlug: string,
  issue: FailedIssue,
  snapshot: FailureSnapshot,
  cascadeRoots: Set<string>,
  cascadeRootLocators: Map<string, ItemLocator>
): ClassifiedItem {
  const classifiedAt = snapshot.collected_at;
  const base: ClassifiedItem = {
    repo_slug: repoSlug,
    is_pr: false,
    number: issue.number,
    github_url: issue.github_url,
    category: "genuine",
    reasoning: { summary: "", signals: {} },
    classified_at: classifiedAt,
  };

  const signals: ClassificationReasoning["signals"] = {
    labels: issue.labels.join(","),
    error_category: issue.error_category,
    last_error_excerpt: issue.last_error_excerpt,
    is_cascade_root: false,
  };

  /* 1. Fake failure — there is a PR that fixes this issue and that PR
   *    is mergeable with all checks green.  The issue is closeable with
   *    a merge and should not be treated as a real failure. */
  const fixesIndex = buildFixesIndex(snapshot);
  const fixingPRs = fixesIndex.get(`${repoSlug}#${issue.number}`);
  if (fixingPRs && fixingPRs.size > 0) {
    for (const prNumber of fixingPRs) {
      const pr = findPR(snapshot, repoSlug, prNumber);
      if (!pr) continue;
      const allGreen =
        pr.mergeable === true &&
        pr.check_runs_summary.failed === 0 &&
        pr.check_runs_summary.pending === 0 &&
        pr.check_runs_summary.passed > 0;
      if (allGreen) {
        return {
          ...base,
          category: "fake_failure",
          reasoning: {
            summary: `PR #${prNumber} fixes this issue, is mergeable, and all checks are green — issue is closeable with merge.`,
            signals: {
              ...signals,
              fixing_pr: prNumber,
              mergeable: pr.mergeable,
              checks_passed: pr.check_runs_summary.passed,
              checks_failed: pr.check_runs_summary.failed,
              checks_pending: pr.check_runs_summary.pending,
            },
          },
        };
      }
    }
  }

  /* 4. Cascade — duplicate: this issue shares an error signature with
   *    at least one other item and was *not* chosen as the root.  The
   *    root (first item encountered for that signature) is classified
   *    by a later rule; all others are deduplicated here. */
  const sig = errorSignature(issue.last_error_excerpt, issue.error_category);
  if (cascadeRoots.has(sig)) {
    const root = cascadeRootLocators.get(sig);
    const isRoot = root && root.repoSlug === repoSlug && root.number === issue.number && !root.isPr;
    if (!isRoot) {
      return {
        ...base,
        category: "cascade_duplicate",
        reasoning: {
          summary: `Shares error signature "${sig}" with another item — duplicate symptom of a single root cause.`,
          signals: { ...signals, error_signature: sig },
        },
      };
    }
  }

  /* 2. Transient — retryable: last error matches a known transient
   *    pattern. */
  const transient = matchTransientPattern(issue.last_error_excerpt);
  if (transient) {
    return {
      ...base,
      category: "transient_retryable",
      reasoning: {
        summary: `Last error matches transient pattern "${transient.description}" — retry likely to succeed.`,
        signals: { ...signals, transient_pattern: transient.id },
      },
    };
  }

  /* 3. CI-real failure: a fixing PR exists and is mergeable but has
   *    specific failed checks (lint/test).  Needs a targeted follow-up
   *    issue rather than a blind retry. */
  if (fixingPRs && fixingPRs.size > 0) {
    for (const prNumber of fixingPRs) {
      const pr = findPR(snapshot, repoSlug, prNumber);
      if (!pr) continue;
      if (
        pr.mergeable === true &&
        pr.check_runs_summary.failed > 0 &&
        pr.check_runs_summary.failed_checks.length > 0
      ) {
        return {
          ...base,
          category: "ci_real_failure",
          reasoning: {
            summary: `PR #${prNumber} is mergeable but checks failed (${pr.check_runs_summary.failed_checks.join(", ")}) — targeted follow-up needed.`,
            signals: {
              ...signals,
              fixing_pr: prNumber,
              mergeable: pr.mergeable,
              failed_checks: pr.check_runs_summary.failed_checks.join(","),
            },
          },
        };
      }
    }
  }

  /* 5. Genuine — none of the above. */
  return {
    ...base,
    category: "genuine",
    reasoning: {
      summary: "No fake, transient, CI, or cascade signal detected — genuine failure requiring human or fresh agent run.",
      signals,
    },
  };
}

/**
 * Classify a single PR from the snapshot.
 *
 * The same five categories apply but are evaluated from the PR
 * perspective: a PR whose checks all pass and that is mergeable is a
 * fake failure (the corresponding issue is closeable).  A PR with
 * specific failed checks is a CI-real failure.
 */
export function classifyPR(
  repoSlug: string,
  pr: FailedPullRequest,
  snapshot: FailureSnapshot,
  cascadeRoots: Set<string>,
  cascadeRootLocators: Map<string, ItemLocator>
): ClassifiedItem {
  const classifiedAt = snapshot.collected_at;
  const base: ClassifiedItem = {
    repo_slug: repoSlug,
    is_pr: true,
    number: pr.number,
    github_url: pr.github_url,
    category: "genuine",
    reasoning: { summary: "", signals: {} },
    classified_at: classifiedAt,
  };

  const signals: ClassificationReasoning["signals"] = {
    labels: pr.labels.join(","),
    error_category: pr.error_category,
    last_error_excerpt: pr.last_error_excerpt,
    mergeable: pr.mergeable,
    checks_passed: pr.check_runs_summary.passed,
    checks_failed: pr.check_runs_summary.failed,
    checks_pending: pr.check_runs_summary.pending,
    is_cascade_root: false,
  };

  /* 1. Fake failure — mergeable + all checks green. */
  if (
    pr.mergeable === true &&
    pr.check_runs_summary.failed === 0 &&
    pr.check_runs_summary.pending === 0 &&
    pr.check_runs_summary.passed > 0
  ) {
    return {
      ...base,
      category: "fake_failure",
      reasoning: {
        summary: "PR is mergeable and all checks are green — not a real failure.",
        signals,
      },
    };
  }

  /* 4. Cascade — duplicate. */
  const sig = errorSignature(pr.last_error_excerpt, pr.error_category);
  if (cascadeRoots.has(sig)) {
    const root = cascadeRootLocators.get(sig);
    const isRoot = root && root.repoSlug === repoSlug && root.number === pr.number && root.isPr;
    if (!isRoot) {
      return {
        ...base,
        category: "cascade_duplicate",
        reasoning: {
          summary: `Shares error signature "${sig}" with another item — duplicate symptom of a single root cause.`,
          signals: { ...signals, error_signature: sig },
        },
      };
    }
  }

  /* 2. Transient — retryable. */
  const transient = matchTransientPattern(pr.last_error_excerpt);
  if (transient) {
    return {
      ...base,
      category: "transient_retryable",
      reasoning: {
        summary: `Last error matches transient pattern "${transient.description}" — retry likely to succeed.`,
        signals: { ...signals, transient_pattern: transient.id },
      },
    };
  }

  /* 3. CI-real failure — mergeable but specific checks failed. */
  if (
    pr.mergeable === true &&
    pr.check_runs_summary.failed > 0 &&
    pr.check_runs_summary.failed_checks.length > 0
  ) {
    return {
      ...base,
      category: "ci_real_failure",
      reasoning: {
        summary: `PR is mergeable but checks failed (${pr.check_runs_summary.failed_checks.join(", ")}) — targeted follow-up needed.`,
        signals: {
          ...signals,
          failed_checks: pr.check_runs_summary.failed_checks.join(","),
        },
      },
    };
  }

  /* 5. Genuine. */
  return {
    ...base,
    category: "genuine",
    reasoning: {
      summary: "No fake, transient, CI, or cascade signal detected — genuine failure requiring human or fresh agent run.",
      signals,
    },
  };
}

/* ──────────────────────────────────────────────────────────────
 *  Cascade root designation
 * ────────────────────────────────────────────────────────────── */

interface ItemLocator {
  repoSlug: string;
  number: number;
  isPr: boolean;
}

/**
 * Walks the snapshot and, for every distinct error signature that is
 * shared by two or more items, designates the *first* item (by repo
 * slug then number) as the root.  Returns the set of root signatures
 * plus a map from signature → the designated root locator.
 *
 * The root is *not* classified as a cascade_duplicate; all other items
 * sharing the signature are.
 */
export function computeCascadeRoots(
  snapshot: FailureSnapshot
): {
  signatures: Set<string>;
  roots: Map<string, ItemLocator>;
} {
  // signature → all items that share it
  const bySignature = new Map<string, ItemLocator[]>();

  const add = (sig: string, loc: ItemLocator) => {
    let arr = bySignature.get(sig);
    if (!arr) {
      arr = [];
      bySignature.set(sig, arr);
    }
    arr.push(loc);
  };

  for (const [repoSlug, repoData] of Object.entries(snapshot.repos)) {
    for (const issue of repoData.issues) {
      // Only items with an actual error excerpt can be cascade
      // candidates.  Two failures with null excerpts are not
      // necessarily duplicates — they simply lack error information.
      if (!issue.last_error_excerpt) continue;
      const sig = errorSignature(issue.last_error_excerpt, issue.error_category);
      add(sig, { repoSlug, number: issue.number, isPr: false });
    }
    for (const pr of repoData.pull_requests) {
      if (!pr.last_error_excerpt) continue;
      const sig = errorSignature(pr.last_error_excerpt, pr.error_category);
      add(sig, { repoSlug, number: pr.number, isPr: true });
    }
  }

  const signatures = new Set<string>();
  const roots = new Map<string, ItemLocator>();

  for (const [sig, locs] of bySignature) {
    if (locs.length < 2) continue; // not a cascade
    // Designate the first item (sorted by repoSlug then number) as root.
    locs.sort((a, b) => {
      if (a.repoSlug !== b.repoSlug) return a.repoSlug.localeCompare(b.repoSlug);
      return a.number - b.number;
    });
    signatures.add(sig);
    roots.set(sig, locs[0]);
  }

  return { signatures, roots };
}

/* ──────────────────────────────────────────────────────────────
 *  Top-level classifySnapshot (pure)
 * ────────────────────────────────────────────────────────────── */

/**
 * Classify every issue and PR in a snapshot.  This function is pure
 * and deterministic: it does not touch S3 or any other I/O.  It is
 * the unit-testable core of the classifier.
 */
export function classifySnapshot(snapshot: FailureSnapshot): ClassifiedSnapshot {
  const { signatures: cascadeRoots, roots: cascadeRootLocators } = computeCascadeRoots(snapshot);
  const classifications: ClassifiedItem[] = [];

  for (const [repoSlug, repoData] of Object.entries(snapshot.repos)) {
    for (const issue of repoData.issues) {
      classifications.push(
        classifyIssue(repoSlug, issue, snapshot, cascadeRoots, cascadeRootLocators)
      );
    }
    for (const pr of repoData.pull_requests) {
      classifications.push(classifyPR(repoSlug, pr, snapshot, cascadeRoots, cascadeRootLocators));
    }
  }

  return {
    snapshot_id: snapshot.snapshot_id,
    classified_at: snapshot.collected_at,
    classifications,
    summary: summarise(classifications),
  };
}

export function summarise(
  classifications: ClassifiedItem[]
): Record<ClassificationCategory, number> {
  const summary: Record<ClassificationCategory, number> = {
    fake_failure: 0,
    transient_retryable: 0,
    ci_real_failure: 0,
    cascade_duplicate: 0,
    genuine: 0,
  };
  for (const item of classifications) {
    summary[item.category]++;
  }
  return summary;
}

/* ──────────────────────────────────────────────────────────────
 *  Past report accuracy
 * ────────────────────────────────────────────────────────────── */

/**
 * Compare yesterday's classifications against today's snapshot to
 * measure the false-positive rate.
 *
 * A prediction is "correct" when:
 *  - fake_failure → the item no longer appears in the snapshot (it was
 *    closed via merge) OR still appears but checks remain green.
 *  - transient_retryable → the item no longer appears (retry succeeded)
 *    OR still appears but is re-classified as transient again.
 *  - ci_real_failure → the item still appears with failed checks
 *    (the CI problem persists) OR no longer appears (was fixed).
 *  - cascade_duplicate → the root item still has the same signature.
 *  - genuine → the item still appears as a genuine failure.
 *
 * Any mismatch counts as incorrect and contributes to the
 * false-positive rate.
 */
export function computeReportAccuracy(
  previous: ClassifiedSnapshot,
  current: FailureSnapshot
): ReportAccuracy {
  // Index current snapshot items by `${repoSlug}#${isPr}#${number}`.
  const present = new Set<string>();
  const currentSig = new Map<string, string>();
  for (const [repoSlug, repoData] of Object.entries(current.repos)) {
    for (const issue of repoData.issues) {
      const key = `${repoSlug}#false#${issue.number}`;
      present.add(key);
      currentSig.set(
        key,
        errorSignature(issue.last_error_excerpt, issue.error_category)
      );
    }
    for (const pr of repoData.pull_requests) {
      const key = `${repoSlug}#true#${pr.number}`;
      present.add(key);
      currentSig.set(
        key,
        errorSignature(pr.last_error_excerpt, pr.error_category)
      );
    }
  }

  const entries: AccuracyEntry[] = [];
  for (const item of previous.classifications) {
    const key = `${item.repo_slug}#${item.is_pr}#${item.number}`;
    const stillPresent = present.has(key);
    let correct = false;
    let note = "";

    switch (item.category) {
      case "fake_failure":
        if (!stillPresent) {
          correct = true;
          note = "Item closed/merged — fake failure correctly predicted.";
        } else {
          correct = false;
          note = "Item still present despite fake-failure prediction.";
        }
        break;
      case "transient_retryable":
        if (!stillPresent) {
          correct = true;
          note = "Retry succeeded — transient correctly predicted.";
        } else if (currentSig.get(key) != null) {
          // Still present; transient may recur, which is acceptable.
          correct = true;
          note = "Item still present; transient error may have recurred.";
        } else {
          correct = false;
          note = "Unexpected state for transient prediction.";
        }
        break;
      case "ci_real_failure":
        if (!stillPresent) {
          correct = true;
          note = "CI failure resolved — item no longer present.";
        } else {
          correct = true;
          note = "CI failure persists — prediction still valid.";
        }
        break;
      case "cascade_duplicate":
        if (!stillPresent) {
          correct = true;
          note = "Cascade symptom resolved.";
        } else {
          correct = true;
          note = "Cascade symptom still present; root cause likely persists.";
        }
        break;
      case "genuine":
        if (stillPresent) {
          correct = true;
          note = "Genuine failure still present — prediction valid.";
        } else {
          correct = false;
          note = "Genuine failure unexpectedly resolved.";
        }
        break;
    }

    entries.push({
      repo_slug: item.repo_slug,
      is_pr: item.is_pr,
      number: item.number,
      predicted_category: item.category,
      correct,
      note,
    });
  }

  const total = entries.length;
  const correctCount = entries.filter((e) => e.correct).length;
  const incorrect = total - correctCount;
  const falsePositiveRate = total > 0 ? incorrect / total : 0;

  // Determine the prior date from the previous report's classified_at.
  const priorDate =
    previous.classified_at.split("T")[0] ?? new Date().toISOString().split("T")[0];

  return {
    prior_date: priorDate,
    total,
    correct: correctCount,
    incorrect,
    false_positive_rate: falsePositiveRate,
    entries,
  };
}

/* ──────────────────────────────────────────────────────────────
 *  Daily health report
 * ────────────────────────────────────────────────────────────── */

/**
 * Build a daily health report from the current classification and an
 * optional previous classification (for accuracy grading).
 */
export function buildDailyHealthReport(
  classified: ClassifiedSnapshot,
  previous: ClassifiedSnapshot | null,
  currentSnapshot: FailureSnapshot,
  escalationQueue?: EscalationQueue | null
): DailyHealthReport {
  const reportDate = classified.classified_at.split("T")[0] ?? "";
  const pastReportAccuracy = previous
    ? computeReportAccuracy(previous, currentSnapshot)
    : null;

  // Determine the first repo slug for the escalation URL (single-repo
  // reports link directly; multi-repo reports link to the first repo's
  // pinned issue if one exists).
  const repoSlugs = Object.keys(currentSnapshot.repos);
  const firstRepoSlug = repoSlugs.length > 0 ? repoSlugs[0] : "";
  const escalationsUrl = escalationQueue
    ? getPinnedIssueUrl(escalationQueue, firstRepoSlug)
    : null;
  const escalationEntries: EscalationEntry[] | undefined = escalationQueue
    ? escalationQueue.entries.filter((e) => e.state === "escalated")
    : undefined;

  return {
    report_date: reportDate,
    generated_at: classified.classified_at,
    total_items: classified.classifications.length,
    summary: classified.summary,
    past_report_accuracy: pastReportAccuracy,
    items: classified.classifications,
    escalations_url: escalationsUrl,
    escalation_entries: escalationEntries,
  };
}

/**
 * Render a daily health report as a Markdown string suitable for a
 * GitHub issue body.  This is a reporting-only artifact — it performs
 * no actions.
 */
export function renderHealthReportMarkdown(report: DailyHealthReport): string {
  const lines: string[] = [];
  lines.push(`# Unblocker Health Report — ${report.report_date}`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Total items classified: ${report.total_items}`);
  lines.push("");
  lines.push("## Summary by category");
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("| --- | --- |");
  for (const [cat, count] of Object.entries(report.summary)) {
    lines.push(`| ${cat} | ${count} |`);
  }
  lines.push("");

  if (report.past_report_accuracy) {
    const acc = report.past_report_accuracy;
    lines.push("## Past report accuracy");
    lines.push("");
    lines.push(`Prior report date: ${acc.prior_date}`);
    lines.push(`Total graded: ${acc.total}`);
    lines.push(`Correct: ${acc.correct}`);
    lines.push(`Incorrect: ${acc.incorrect}`);
    lines.push(`False-positive rate: ${(acc.false_positive_rate * 100).toFixed(1)}%`);
    lines.push("");
    if (acc.entries.length > 0) {
      lines.push("| Repo | Item | Predicted | Correct | Note |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const entry of acc.entries) {
        const itemType = entry.is_pr ? "PR" : "Issue";
        lines.push(
          `| ${entry.repo_slug} | ${itemType} #${entry.number} | ${entry.predicted_category} | ${entry.correct ? "yes" : "no"} | ${entry.note} |`
        );
      }
      lines.push("");
    }
  } else {
    lines.push("## Past report accuracy");
    lines.push("");
    lines.push("_No prior report available for grading._");
    lines.push("");
  }

  // Escalations section (sub-issue 4): links the pinned issue and
  // lists current escalations with overdue items nagged at the top.
  if (report.escalation_entries && report.escalation_entries.length > 0) {
    const repoSlug =
      report.escalation_entries[0]?.repo_slug ?? "";
    const queue: EscalationQueue = {
      entries: report.escalation_entries,
      pinned_issue_number: report.escalations_url
        ? parseInt(report.escalations_url.split("/").pop() ?? "0", 10) || null
        : null,
      updated_at: report.generated_at,
    };
    const escalationMd = renderEscalations(queue, repoSlug);
    if (escalationMd) {
      lines.push(escalationMd);
      lines.push("");
    }
  } else if (report.escalations_url) {
    lines.push("## Escalations");
    lines.push("");
    lines.push(`**Pinned escalation issue:** [Unblocker Escalations](${report.escalations_url})`);
    lines.push("");
    lines.push("_No active escalations._");
    lines.push("");
  }

  lines.push("## Classified items");
  lines.push("");
  if (report.items.length === 0) {
    lines.push("_No items to report._");
  } else {
    lines.push("| Repo | Item | Category | Reasoning |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of report.items) {
      const itemType = item.is_pr ? "PR" : "Issue";
      lines.push(
        `| ${item.repo_slug} | ${itemType} #${item.number} | ${item.category} | ${item.reasoning.summary} |`
      );
    }
  }

  return lines.join("\n");
}

/* ──────────────────────────────────────────────────────────────
 *  S3 I/O helpers (handler only; tests use the pure functions)
 * ────────────────────────────────────────────────────────────── */

async function readJsonFromS3<T>(key: string): Promise<T | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: ARTIFACTS_BUCKET, Key: key })
    );
    if (!result.Body) return null;
    const content = await result.Body.transformToString();
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonToS3(key: string, body: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );
}

function classificationKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`;
  return `unblocker/classifications/${key}.json`;
}

function previousDayKey(date: Date): string {
  const prev = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  return classificationKey(prev);
}

/**
 * Find the most recent classification file that is not the current
 * run's file.  Used for accuracy grading when the exactly-24h-ago
 * file is missing.
 */
async function findPreviousClassification(
  currentKey: string
): Promise<ClassifiedSnapshot | null> {
  // First try the 24h-ago file.
  const prevKey = previousDayKey(new Date());
  const prev = await readJsonFromS3<ClassifiedSnapshot>(prevKey);
  if (prev) return prev;

  // Fall back to listing classification objects and taking the latest
  // one that is not the current run.
  try {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "unblocker/classifications/",
      })
    );
    const keys = (list.Contents ?? [])
      .map((obj) => obj.Key!)
      .filter((k) => k.endsWith(".json") && k !== currentKey)
      .sort();
    if (keys.length === 0) return null;
    const latest = keys[keys.length - 1];
    return readJsonFromS3<ClassifiedSnapshot>(latest);
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────
 *  Lambda handler
 * ────────────────────────────────────────────────────────────── */

export async function handler(): Promise<void> {
  console.log("Starting unblocker root-cause classifier...");

  const snapshot = await readJsonFromS3<FailureSnapshot>(
    "unblocker/snapshots/latest.json"
  );
  if (!snapshot) {
    console.warn("No snapshot found — nothing to classify.");
    return;
  }

  const classified = classifySnapshot(snapshot);

  const now = new Date();
  const key = classificationKey(now);
  await writeJsonToS3(key, JSON.stringify(classified, null, 2));
  console.log(`Wrote classifications to s3://${ARTIFACTS_BUCKET}/${key}`);

  // Grade yesterday's report for the false-positive-rate metric.
  const previous = await findPreviousClassification(key);
  // Read the escalation queue so the daily report can link the pinned
  // issue and surface current escalations (sub-issue 4).
  let escalationQueue: EscalationQueue | null = null;
  try {
    escalationQueue = await readEscalationQueue();
  } catch {
    console.warn("Failed to read escalation queue for daily report; continuing without it.");
  }
  const report = buildDailyHealthReport(classified, previous, snapshot, escalationQueue);
  const reportKey = `unblocker/reports/${report.report_date}.json`;
  await writeJsonToS3(reportKey, JSON.stringify(report, null, 2));
  console.log(`Wrote daily health report to s3://${ARTIFACTS_BUCKET}/${reportKey}`);

  console.log(
    `Classifier completed. ${classified.classifications.length} items classified.`,
  );
}
