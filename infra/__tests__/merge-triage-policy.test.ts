import {
  MergeTriageCandidate,
  planMergeTriage,
} from "../lib/merge-triage-policy";

const now = new Date("2026-06-28T12:00:00Z");

function candidate(
  number: number,
  overrides: Partial<MergeTriageCandidate> = {}
): MergeTriageCandidate {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    author: "app/cenetex",
    headSha: `sha-${number}`,
    headRef: `branch-${number}`,
    baseRef: "main",
    labels: ["review:approved"],
    isDraft: false,
    mergeable: true,
    mergeableState: "clean",
    files: [`src/file-${number}.ts`],
    additions: 10,
    deletions: 2,
    protectedFiles: [],
    botApproved: true,
    reviewApprovedAt: "2026-06-28T10:30:00Z",
    checksState: "success",
    ...overrides,
  };
}

describe("merge triage policy", () => {
  it("selects only the lowest-risk PR from an overlapping group", () => {
    const plan = planMergeTriage(
      [
        candidate(10, {
          files: ["inspector_panel.py", "test_dashboard.py"],
          additions: 220,
        }),
        candidate(11, {
          files: ["inspector_panel.py"],
          additions: 20,
        }),
        candidate(12, {
          files: ["docs/readme.md"],
          additions: 5,
        }),
      ],
      { now, defaultHoldMinutes: 60, maxReady: 3 }
    );

    expect(plan.ready.map((item) => item.candidate.number)).toEqual([11, 12]);
    expect(plan.queued.map((item) => item.candidate.number)).toEqual([10]);
    expect(plan.queued[0].reasons[0]).toContain("Overlaps with PR #11");
  });

  it("keeps approved PRs waiting until the hold period passes", () => {
    const plan = planMergeTriage(
      [candidate(20, { reviewApprovedAt: "2026-06-28T11:45:00Z" })],
      { now, defaultHoldMinutes: 60, maxReady: 1 }
    );

    expect(plan.ready).toHaveLength(0);
    expect(plan.waiting.map((item) => item.candidate.number)).toEqual([20]);
    expect(plan.waiting[0].reasons[0]).toContain("Hold period still active");
  });

  it("waits for an approving bot review", () => {
    const plan = planMergeTriage(
      [candidate(21, { botApproved: false })],
      { now, defaultHoldMinutes: 60, maxReady: 1 }
    );

    expect(plan.waiting.map((item) => item.candidate.number)).toEqual([21]);
    expect(plan.waiting[0].reasons[0]).toContain("approving bot review");
  });

  it("flags protected files and merge conflicts as non-mergeable work", () => {
    const plan = planMergeTriage(
      [
        candidate(30, {
          files: ["infra/lib/stack.ts"],
          protectedFiles: ["infra/lib/stack.ts"],
        }),
        candidate(31, {
          mergeable: false,
          mergeableState: "dirty",
        }),
      ],
      { now, defaultHoldMinutes: 60, maxReady: 1 }
    );

    expect(plan.blocked.map((item) => item.candidate.number)).toEqual([30]);
    expect(plan.conflicts.map((item) => item.candidate.number)).toEqual([31]);
  });

  it("throttles otherwise independent ready PRs to the configured per-run cap", () => {
    const plan = planMergeTriage(
      [
        candidate(40),
        candidate(41),
        candidate(42),
      ],
      { now, defaultHoldMinutes: 60, maxReady: 1 }
    );

    expect(plan.ready.map((item) => item.candidate.number)).toEqual([40]);
    expect(plan.queued.map((item) => item.candidate.number)).toEqual([41, 42]);
    expect(plan.queued[0].reasons[0]).toContain("concurrency limit");
  });
});
