import { hasBlockingAutoMergeLabel } from "./review-policy";
import { CODING_AGENT_BOT_LOGINS } from "./types";

export type MergeCheckState = "success" | "failure" | "pending" | "unknown";

export type MergeTriageStatus =
  | "ready"
  | "queued"
  | "waiting"
  | "blocked"
  | "conflict"
  | "stale";

export const MERGE_TRIAGE_LABELS: Record<MergeTriageStatus, string> = {
  ready: "merge:ready",
  queued: "merge:queued",
  waiting: "merge:waiting",
  blocked: "merge:blocked",
  conflict: "merge:conflict",
  stale: "merge:stale",
};

export const ALL_MERGE_TRIAGE_LABELS = Object.values(MERGE_TRIAGE_LABELS);

export interface MergeTriageCandidate {
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  labels: string[];
  isDraft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  files: string[];
  additions: number;
  deletions: number;
  protectedFiles: string[];
  botApproved: boolean;
  reviewApprovedAt?: string;
  requiredHoldMinutes?: number;
  createdAt?: string;
  checksState?: MergeCheckState;
}

export interface MergeTriageOptions {
  now?: Date;
  defaultHoldMinutes: number;
  maxReady: number;
  botLogins?: string[];
}

export interface MergePlanItem {
  candidate: MergeTriageCandidate;
  status: MergeTriageStatus;
  reasons: string[];
  riskScore: number;
  overlapWith: number[];
  queueRank?: number;
}

export interface MergePlan {
  generatedAt: string;
  items: MergePlanItem[];
  ready: MergePlanItem[];
  queued: MergePlanItem[];
  waiting: MergePlanItem[];
  blocked: MergePlanItem[];
  conflicts: MergePlanItem[];
  stale: MergePlanItem[];
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function isCodingAgentAuthor(
  author: string,
  botLogins: string[] = CODING_AGENT_BOT_LOGINS
): boolean {
  const normalizedAuthor = normalizeLogin(author);

  return botLogins.some((login) => {
    const normalizedBot = normalizeLogin(login);
    const botStem = normalizedBot.replace("[bot]", "");
    return normalizedAuthor === normalizedBot || normalizedAuthor.includes(botStem);
  });
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function minutesSince(value: string | undefined, now: Date): number | null {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) {
    return null;
  }

  return (now.getTime() - timestamp) / (1000 * 60);
}

export function calculateRiskScore(candidate: MergeTriageCandidate): number {
  const lineCount = candidate.additions + candidate.deletions;
  const lineScore = Math.min(200, Math.ceil(lineCount / 20));
  const fileScore = candidate.files.length * 5;
  const protectedScore = candidate.protectedFiles.length > 0 ? 500 : 0;
  const infraScore = candidate.files.some(
    (file) => file.startsWith("infra/") || file.startsWith(".github/")
  )
    ? 75
    : 0;

  return lineScore + fileScore + protectedScore + infraScore;
}

export function filesOverlap(left: string[], right: string[]): boolean {
  const rightFiles = new Set(right);
  return left.some((file) => rightFiles.has(file));
}

function initialStatusForCandidate(
  candidate: MergeTriageCandidate,
  options: Required<MergeTriageOptions>
): Pick<MergePlanItem, "status" | "reasons"> {
  if (!isCodingAgentAuthor(candidate.author, options.botLogins)) {
    return {
      status: "blocked",
      reasons: ["PR was not opened by a configured coding-agent identity."],
    };
  }

  if (candidate.isDraft) {
    return {
      status: "waiting",
      reasons: ["PR is still a draft."],
    };
  }

  if (hasBlockingAutoMergeLabel(candidate.labels)) {
    return {
      status: "blocked",
      reasons: ["PR has a blocking auto-merge label."],
    };
  }

  if (!candidate.labels.includes("review:approved")) {
    return {
      status: "waiting",
      reasons: ["Waiting for the current review:approved label."],
    };
  }

  if (!candidate.botApproved) {
    return {
      status: "waiting",
      reasons: ["Waiting for an approving bot review."],
    };
  }

  const requiredHoldMinutes =
    candidate.requiredHoldMinutes ?? options.defaultHoldMinutes;
  const holdAgeMinutes = minutesSince(candidate.reviewApprovedAt, options.now);

  if (holdAgeMinutes === null) {
    return {
      status: "waiting",
      reasons: ["Could not find the review:approved label timestamp."],
    };
  }

  if (holdAgeMinutes < requiredHoldMinutes) {
    return {
      status: "waiting",
      reasons: [
        `Hold period still active (${Math.floor(holdAgeMinutes)}/${requiredHoldMinutes} minutes).`,
      ],
    };
  }

  if (candidate.protectedFiles.length > 0) {
    return {
      status: "blocked",
      reasons: [
        `Protected files require manual handling: ${candidate.protectedFiles.join(", ")}.`,
      ],
    };
  }

  if (candidate.checksState === "failure") {
    return {
      status: "blocked",
      reasons: ["Required checks are failing."],
    };
  }

  if (candidate.checksState === "pending") {
    return {
      status: "waiting",
      reasons: ["Required checks are still pending."],
    };
  }

  const mergeableState = candidate.mergeableState?.toLowerCase() ?? "unknown";

  if (mergeableState === "dirty" || mergeableState === "conflicting") {
    return {
      status: "conflict",
      reasons: ["PR has merge conflicts with the base branch."],
    };
  }

  if (mergeableState === "behind") {
    return {
      status: "stale",
      reasons: ["PR branch is behind the base branch and needs an update."],
    };
  }

  if (mergeableState === "unstable") {
    return {
      status: "blocked",
      reasons: ["GitHub reports the PR as unstable."],
    };
  }

  if (mergeableState !== "clean") {
    return {
      status: "waiting",
      reasons: [`GitHub mergeable state is ${mergeableState}.`],
    };
  }

  if (candidate.mergeable === false) {
    return {
      status: "conflict",
      reasons: ["GitHub reports the PR is not mergeable."],
    };
  }

  return {
    status: "ready",
    reasons: ["All merge gates are satisfied."],
  };
}

function comparePlanItems(left: MergePlanItem, right: MergePlanItem): number {
  if (left.riskScore !== right.riskScore) {
    return left.riskScore - right.riskScore;
  }

  const leftApprovedAt = parseTimestamp(left.candidate.reviewApprovedAt);
  const rightApprovedAt = parseTimestamp(right.candidate.reviewApprovedAt);

  if (leftApprovedAt !== null && rightApprovedAt !== null && leftApprovedAt !== rightApprovedAt) {
    return leftApprovedAt - rightApprovedAt;
  }

  return left.candidate.number - right.candidate.number;
}

function connectedReadyGroups(items: MergePlanItem[]): MergePlanItem[][] {
  const byNumber = new Map(items.map((item) => [item.candidate.number, item]));
  const visited = new Set<number>();
  const groups: MergePlanItem[][] = [];

  for (const item of items) {
    if (visited.has(item.candidate.number)) {
      continue;
    }

    const group: MergePlanItem[] = [];
    const stack = [item.candidate.number];

    while (stack.length > 0) {
      const currentNumber = stack.pop()!;
      if (visited.has(currentNumber)) {
        continue;
      }

      const current = byNumber.get(currentNumber);
      if (!current) {
        continue;
      }

      visited.add(currentNumber);
      group.push(current);

      for (const overlapNumber of current.overlapWith) {
        if (!visited.has(overlapNumber)) {
          stack.push(overlapNumber);
        }
      }
    }

    groups.push(group);
  }

  return groups;
}

function finalizePlan(generatedAt: string, items: MergePlanItem[]): MergePlan {
  return {
    generatedAt,
    items,
    ready: items.filter((item) => item.status === "ready"),
    queued: items.filter((item) => item.status === "queued"),
    waiting: items.filter((item) => item.status === "waiting"),
    blocked: items.filter((item) => item.status === "blocked"),
    conflicts: items.filter((item) => item.status === "conflict"),
    stale: items.filter((item) => item.status === "stale"),
  };
}

export function planMergeTriage(
  candidates: MergeTriageCandidate[],
  options: MergeTriageOptions
): MergePlan {
  const normalizedOptions: Required<MergeTriageOptions> = {
    now: options.now ?? new Date(),
    defaultHoldMinutes: options.defaultHoldMinutes,
    maxReady: Math.max(1, options.maxReady),
    botLogins: options.botLogins ?? CODING_AGENT_BOT_LOGINS,
  };
  const generatedAt = normalizedOptions.now.toISOString();

  const items: MergePlanItem[] = candidates.map((candidate) => {
    const initial = initialStatusForCandidate(candidate, normalizedOptions);
    return {
      candidate,
      status: initial.status,
      reasons: [...initial.reasons],
      riskScore: calculateRiskScore(candidate),
      overlapWith: [],
    };
  });

  const initiallyReady = items.filter((item) => item.status === "ready");

  for (let i = 0; i < initiallyReady.length; i += 1) {
    for (let j = i + 1; j < initiallyReady.length; j += 1) {
      const left = initiallyReady[i];
      const right = initiallyReady[j];

      if (!filesOverlap(left.candidate.files, right.candidate.files)) {
        continue;
      }

      left.overlapWith.push(right.candidate.number);
      right.overlapWith.push(left.candidate.number);
    }
  }

  const groups = connectedReadyGroups(initiallyReady);
  const groupWinners = new Set<MergePlanItem>();

  for (const group of groups) {
    const orderedGroup = [...group].sort(comparePlanItems);
    const winner = orderedGroup[0];
    groupWinners.add(winner);

    for (const queuedItem of orderedGroup.slice(1)) {
      queuedItem.status = "queued";
      queuedItem.reasons = [
        `Overlaps with PR #${winner.candidate.number}; waiting for that PR to merge and for this branch to be rechecked.`,
      ];
    }
  }

  const orderedWinners = [...groupWinners].sort(comparePlanItems);

  orderedWinners.forEach((item, index) => {
    item.queueRank = index + 1;

    if (index >= normalizedOptions.maxReady) {
      item.status = "queued";
      item.reasons = [
        `Waiting for merge triage concurrency limit (${normalizedOptions.maxReady} ready per run).`,
      ];
    }
  });

  return finalizePlan(generatedAt, items);
}
