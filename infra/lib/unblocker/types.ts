import type { TaskMetadata } from "../types";

/* -- Snapshot types (shared between collector and classifier) -- */

export interface FailedIssue {
  number: number;
  title: string;
  labels: string[];
  last_failure_task_id: string | null;
  last_error_excerpt: string | null;
  error_category: string | null;
  github_url: string;
  created_at: string;
  last_updated: string;
}

export interface FailedPullRequest {
  number: number;
  title: string;
  labels: string[];
  head_sha: string;
  mergeable: boolean | null;
  check_runs_summary: {
    total: number;
    failed: number;
    pending: number;
    passed: number;
    failed_checks: string[];
  };
  last_failure_task_id: string | null;
  last_error_excerpt: string | null;
  error_category: string | null;
  github_url: string;
  created_at: string;
  last_updated: string;
}

export interface CrossReference {
  type: "fixes" | "blocked_by";
  from: { issue_number: number; repo: string; is_pr: boolean };
  to: { issue_number: number; repo: string };
}

export interface RepoFailureData {
  repo_slug: string;
  issues: FailedIssue[];
  pull_requests: FailedPullRequest[];
  cross_references: CrossReference[];
  summary: {
    total_failed: number;
    total_waiting: number;
  };
}

export interface FailureSnapshot {
  snapshot_id: string;
  collected_at: string;
  repos: Record<string, RepoFailureData>;
}

/* -- Classification types -- */

export type ClassificationCategory =
  | "fake_failure"
  | "transient_retryable"
  | "ci_real_failure"
  | "cascade_duplicate"
  | "genuine";

export interface ClassificationReasoning {
  summary: string;
  signals: Record<string, string | number | boolean | null>;
}

export interface ClassifiedItem {
  repo_slug: string;
  is_pr: boolean;
  number: number;
  github_url: string;
  category: ClassificationCategory;
  reasoning: ClassificationReasoning;
  classified_at: string;
}

export interface ClassifiedSnapshot {
  snapshot_id: string;
  classified_at: string;
  classifications: ClassifiedItem[];
  summary: Record<ClassificationCategory, number>;
}

export interface AccuracyEntry {
  repo_slug: string;
  is_pr: boolean;
  number: number;
  predicted_category: ClassificationCategory;
  correct: boolean;
  note: string;
}

export interface ReportAccuracy {
  prior_date: string;
  total: number;
  correct: number;
  incorrect: number;
  false_positive_rate: number;
  entries: AccuracyEntry[];
}

export interface DailyHealthReport {
  report_date: string;
  generated_at: string;
  total_items: number;
  summary: Record<ClassificationCategory, number>;
  past_report_accuracy: ReportAccuracy | null;
  items: ClassifiedItem[];
  /** URL of the pinned escalation issue (sub-issue 4). Null/absent if none. */
  escalations_url?: string | null;
  /** Escalation entries surfaced in the daily report (sub-issue 4). */
  escalation_entries?: EscalationEntry[];
}

/* -- Escalation queue types (sub-issue 4) -- */

/** A single escalated item entry on the pinned issue body. */
export interface EscalationEntry {
  repo_slug: string;
  number: number;
  is_pr: boolean;
  github_url: string;
  root_cause_hypothesis: string;
  what_was_tried: string;
  recommended_action: string;
  escalated_at: string;
  last_attempt_count: number;
  state: "escalated" | "resolved";
}

/** The full escalation queue as persisted in S3 and on the pinned issue. */
export interface EscalationQueue {
  entries: EscalationEntry[];
  pinned_issue_number: number | null;
  updated_at: string;
}

/** Data passed to the optional escalation webhook. */
export interface EscalationWebhookPayload {
  repo_slug: string;
  number: number;
  is_pr: boolean;
  github_url: string;
  root_cause_hypothesis: string;
  what_was_tried: string;
  recommended_action: string;
  escalated_at: string;
  attempt_count: number;
  escalation_issue_url: string | null;
}

export type { TaskMetadata };
