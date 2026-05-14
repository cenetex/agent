export interface GitHubReviewSummary {
  state?: string;
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

export function isHumanApprovalReview(review: GitHubReviewSummary): boolean {
  return isHumanReview(review) && review.state === "APPROVED";
}

function isHumanReview(review: GitHubReviewSummary): boolean {
  const login = review.user?.login ?? "";
  const type = review.user?.type ?? "";

  if (!login) {
    return false;
  }

  if (type === "Bot" || login.endsWith("[bot]")) {
    return false;
  }

  return true;
}

export function hasCurrentHumanApproval(reviews: GitHubReviewSummary[]): boolean {
  const latestByReviewer = new Map<string, GitHubReviewSummary>();
  const sortedReviews = [...reviews].sort((a, b) => {
    const aTime = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
    const bTime = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
    return aTime - bTime;
  });

  for (const review of sortedReviews) {
    if (!isHumanReview(review)) {
      continue;
    }
    latestByReviewer.set(review.user!.login!, review);
  }

  const latestStates = [...latestByReviewer.values()].map((review) => review.state);
  return latestStates.includes("APPROVED") && !latestStates.includes("CHANGES_REQUESTED");
}
