export interface GitHubReviewSummary {
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  user?: {
    login?: string;
    type?: string;
  } | null;
}

const AUTO_MERGE_BLOCKING_LABELS = new Set([
  "pause-agent",
  "review:human-required",
]);

export function hasBlockingAutoMergeLabel(labels: string[]): boolean {
  return labels.some((label) => AUTO_MERGE_BLOCKING_LABELS.has(label));
}

function submittedAtMillis(review: GitHubReviewSummary): number {
  if (!review.submitted_at) {
    return 0;
  }
  const parsed = new Date(review.submitted_at).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function hasCurrentBotApproval(
  reviews: GitHubReviewSummary[],
  botLogins: readonly string[],
  headSha: string
): boolean {
  const logins = new Set(botLogins.map((login) => login.toLowerCase()));
  const latestByReviewer = new Map<string, GitHubReviewSummary>();

  for (const review of reviews) {
    const login = review.user?.login ?? "";
    if (!logins.has(login.toLowerCase())) {
      continue;
    }
    const existing = latestByReviewer.get(login);
    if (!existing || submittedAtMillis(review) >= submittedAtMillis(existing)) {
      latestByReviewer.set(login, review);
    }
  }

  const latest = [...latestByReviewer.values()];
  const approved = latest.some(
    (review) => review.state === "APPROVED" && review.commit_id === headSha
  );
  const changesRequested = latest.some(
    (review) => review.state === "CHANGES_REQUESTED"
  );

  return approved && !changesRequested;
}
