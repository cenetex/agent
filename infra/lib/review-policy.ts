export interface GitHubReviewSummary {
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  user?: {
    login?: string;
    type?: string;
  } | null;
}

export interface GitHubReviewAttestationComment {
  id?: number;
  body?: string | null;
  created_at?: string;
  user?: {
    login?: string;
    type?: string;
  } | null;
}

const REVIEW_ATTESTATION_PATTERN =
  /^<!-- cenetex-review-attestation:v1 head=([0-9a-f]{40}|[0-9a-f]{64}) decision=(approved|changes_requested|error) task=([a-zA-Z0-9_-]+) -->$/;

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

function commentCreatedAtMillis(comment: GitHubReviewAttestationComment): number {
  if (!comment.created_at) {
    return 0;
  }
  const parsed = new Date(comment.created_at).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function hasCurrentBotAttestation(
  comments: GitHubReviewAttestationComment[],
  botLogins: readonly string[],
  headSha: string
): boolean {
  const logins = new Set(botLogins.map((login) => login.toLowerCase()));
  const attestations = comments
    .filter((comment) => {
      const login = comment.user?.login ?? "";
      return comment.user?.type === "Bot" && logins.has(login.toLowerCase());
    })
    .map((comment) => {
      const firstLine = (comment.body ?? "").split(/\r?\n/, 1)[0];
      const match = REVIEW_ATTESTATION_PATTERN.exec(firstLine);
      return match
        ? {
            comment,
            headSha: match[1],
            decision: match[2],
          }
        : null;
    })
    .filter((attestation): attestation is NonNullable<typeof attestation> =>
      attestation !== null && attestation.headSha === headSha
    )
    .sort((left, right) => {
      const timestampDifference =
        commentCreatedAtMillis(right.comment) - commentCreatedAtMillis(left.comment);
      if (timestampDifference !== 0) {
        return timestampDifference;
      }
      return (right.comment.id ?? 0) - (left.comment.id ?? 0);
    });

  return attestations[0]?.decision === "approved";
}
