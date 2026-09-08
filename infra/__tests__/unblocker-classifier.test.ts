import {
  classifySnapshot,
  computeCascadeRoots,
  errorSignature,
  matchTransientPattern,
  TRANSIENT_PATTERNS,
  computeReportAccuracy,
  buildDailyHealthReport,
  renderHealthReportMarkdown,
} from "../lib/unblocker/classifier";
import type {
  FailureSnapshot,
  FailedIssue,
  FailedPullRequest,
  ClassifiedSnapshot,
  CrossReference,
  RepoFailureData,
} from "../lib/unblocker/types";

const COLLECTED_AT = "2026-09-07T21:00:00Z";

function makeRepo(
  slug: string,
  issues: FailedIssue[],
  prs: FailedPullRequest[],
  xrefs: CrossReference[] = []
): [string, RepoFailureData] {
  return [
    slug,
    {
      repo_slug: slug,
      issues,
      pull_requests: prs,
      cross_references: xrefs,
      summary: {
        total_failed: issues.length,
        total_waiting: prs.length,
      },
    },
  ];
}

function makeIssue(
  number: number,
  overrides: Partial<FailedIssue> = {}
): FailedIssue {
  return {
    number,
    title: `Issue ${number}`,
    labels: ["agent:failed"],
    last_failure_task_id: `task_issue_${number}`,
    last_error_excerpt: null,
    error_category: null,
    github_url: `https://github.com/cenetex/agent/issues/${number}`,
    created_at: "2026-09-01T00:00:00Z",
    last_updated: "2026-09-07T20:00:00Z",
    ...overrides,
  };
}

function makePR(
  number: number,
  overrides: Partial<FailedPullRequest> = {}
): FailedPullRequest {
  return {
    number,
    title: `PR ${number}`,
    labels: ["agent:failed"],
    head_sha: `sha-${number}`,
    mergeable: null,
    check_runs_summary: {
      total: 0,
      failed: 0,
      pending: 0,
      passed: 0,
      failed_checks: [],
    },
    last_failure_task_id: `task_pr_${number}`,
    last_error_excerpt: null,
    error_category: null,
    github_url: `https://github.com/cenetex/agent/pull/${number}`,
    created_at: "2026-09-01T00:00:00Z",
    last_updated: "2026-09-07T20:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(
  repos: [string, RepoFailureData][]
): FailureSnapshot {
  return {
    snapshot_id: "snapshot_test",
    collected_at: COLLECTED_AT,
    repos: Object.fromEntries(repos),
  };
}

/* ── Transient pattern matching ── */

describe("matchTransientPattern", () => {
  it("matches OpenRouter 402 payment required", () => {
    const p = matchTransientPattern("OpenRouter error 402 Payment required");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("openrouter_402");
  });

  it("matches insufficient credits error", () => {
    const p = matchTransientPattern("Error: insufficient credits available");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("openrouter_insufficient_credits");
  });

  it("matches GitHub 5xx server error", () => {
    const p = matchTransientPattern("api.github.com returned 503 service unavailable");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("github_5xx");
  });

  it("matches ECS SIGTERM", () => {
    const p = matchTransientPattern("ECS task received SIGTERM, stopping container");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("ecs_sigterm");
  });

  it("matches network timeout", () => {
    const p = matchTransientPattern("fetch failed: ETIMEDOUT");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("network_timeout");
  });

  it("returns null for non-transient errors", () => {
    expect(matchTransientPattern("TypeError: undefined is not a function")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(matchTransientPattern(null)).toBeNull();
  });

  it("has exactly 5 transient patterns", () => {
    expect(TRANSIENT_PATTERNS).toHaveLength(5);
  });
});

/* ── errorSignature ── */

describe("errorSignature", () => {
  it("normalises numbers so cascades collapse", () => {
    const a = errorSignature("Insufficient credits: need 8, have -4", "credit_exhaustion");
    const b = errorSignature("Insufficient credits: need 12, have 0", "credit_exhaustion");
    expect(a).toBe(b);
  });

  it("returns category only when excerpt is null", () => {
    expect(errorSignature(null, "timeout")).toBe("timeout");
  });

  it("returns unknown when both are null", () => {
    expect(errorSignature(null, null)).toBe("unknown");
  });

  it("truncates long excerpts", () => {
    const long = "x".repeat(200);
    const sig = errorSignature(long, "cat");
    expect(sig.length).toBeLessThan(long.length + 10);
  });
});

/* ── computeCascadeRoots ── */

describe("computeCascadeRoots", () => {
  it("designates the first item as root for shared signatures", () => {
    const snapshot = makeSnapshot([
      makeRepo("cenetex/agent", [
        makeIssue(120, { last_error_excerpt: "zombie agent stuck", error_category: "stuck" }),
        makeIssue(121, { last_error_excerpt: "zombie agent stuck", error_category: "stuck" }),
      ], []),
    ]);
    const { signatures, roots } = computeCascadeRoots(snapshot);
    expect(signatures.size).toBe(1);
    const sig = [...signatures][0];
    const root = roots.get(sig);
    expect(root).toEqual({ repoSlug: "cenetex/agent", number: 120, isPr: false });
  });

  it("does not mark single items as cascade roots", () => {
    const snapshot = makeSnapshot([
      makeRepo("cenetex/agent", [
        makeIssue(100, { last_error_excerpt: "unique error A", error_category: "bug" }),
      ], []),
    ]);
    const { signatures } = computeCascadeRoots(snapshot);
    expect(signatures.size).toBe(0);
  });

  it("does not cascade items with null error excerpts", () => {
    // Two issues with null excerpts should NOT be treated as cascade
    // duplicates — they simply lack error information.
    const snapshot = makeSnapshot([
      makeRepo("cenetex/agent", [
        makeIssue(200),
        makeIssue(201),
      ], []),
    ]);
    const { signatures } = computeCascadeRoots(snapshot);
    expect(signatures.size).toBe(0);
    const result = classifySnapshot(snapshot);
    const c200 = result.classifications.find((c) => c.number === 200);
    const c201 = result.classifications.find((c) => c.number === 201);
    expect(c200!.category).not.toBe("cascade_duplicate");
    expect(c201!.category).not.toBe("cascade_duplicate");
  });
});

/* ── Category 1: fake_failure ── */

describe("classifySnapshot — fake_failure", () => {
  it("classifies an issue as fake_failure when a fixing PR is mergeable + green", () => {
    const issue = makeIssue(42);
    const pr = makePR(47, {
      mergeable: true,
      check_runs_summary: {
        total: 3, failed: 0, pending: 0, passed: 3, failed_checks: [],
      },
    });
    const xref: CrossReference = {
      type: "fixes",
      from: { issue_number: 47, repo: "cenetex/kyro", is_pr: true },
      to: { issue_number: 42, repo: "cenetex/kyro" },
    };
    const snapshot = makeSnapshot([
      makeRepo("cenetex/kyro", [issue], [pr], [xref]),
    ]);

    const result = classifySnapshot(snapshot);
    const issueClassification = result.classifications.find(
      (c) => !c.is_pr && c.number === 42
    );
    expect(issueClassification).toBeDefined();
    expect(issueClassification!.category).toBe("fake_failure");
    expect(result.summary.fake_failure).toBeGreaterThanOrEqual(1);
  });

  it("classifies a PR as fake_failure when mergeable + all checks green", () => {
    const pr = makePR(99, {
      mergeable: true,
      check_runs_summary: {
        total: 2, failed: 0, pending: 0, passed: 2, failed_checks: [],
      },
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [], [pr])]);
    const result = classifySnapshot(snapshot);
    const prClassification = result.classifications.find(
      (c) => c.is_pr && c.number === 99
    );
    expect(prClassification).toBeDefined();
    expect(prClassification!.category).toBe("fake_failure");
  });
});

/* ── Category 2: transient_retryable ── */

describe("classifySnapshot — transient_retryable", () => {
  it("classifies an issue with OpenRouter 402 as transient", () => {
    const issue = makeIssue(43, {
      last_error_excerpt: "OpenRouter 402 Payment required: insufficient credits",
      error_category: "credit_exhaustion",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/raticross", [issue], [])]);
    const result = classifySnapshot(snapshot);
    const c = result.classifications.find((c) => c.number === 43);
    expect(c!.category).toBe("transient_retryable");
    expect(c!.reasoning.signals.transient_pattern).toBe("openrouter_402");
  });

  it("classifies a PR with network timeout as transient", () => {
    const pr = makePR(55, {
      last_error_excerpt: "Request timed out after 30000ms",
      error_category: "timeout",
      mergeable: null,
      check_runs_summary: {
        total: 0, failed: 0, pending: 0, passed: 0, failed_checks: [],
      },
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [], [pr])]);
    const result = classifySnapshot(snapshot);
    const c = result.classifications.find((c) => c.is_pr && c.number === 55);
    expect(c!.category).toBe("transient_retryable");
  });
});

/* ── Category 3: ci_real_failure ── */

describe("classifySnapshot — ci_real_failure", () => {
  it("classifies an issue as ci_real_failure when fixing PR has failed checks", () => {
    // kyro #42 / PR #47 — CI-real failure (lint + test)
    const issue = makeIssue(42);
    const pr = makePR(47, {
      mergeable: true,
      check_runs_summary: {
        total: 3, failed: 2, pending: 0, passed: 1,
        failed_checks: ["lint", "test"],
      },
    });
    const xref: CrossReference = {
      type: "fixes",
      from: { issue_number: 47, repo: "cenetex/kyro", is_pr: true },
      to: { issue_number: 42, repo: "cenetex/kyro" },
    };
    const snapshot = makeSnapshot([
      makeRepo("cenetex/kyro", [issue], [pr], [xref]),
    ]);
    const result = classifySnapshot(snapshot);
    const issueClassification = result.classifications.find(
      (c) => !c.is_pr && c.number === 42
    );
    expect(issueClassification!.category).toBe("ci_real_failure");
    const prClassification = result.classifications.find(
      (c) => c.is_pr && c.number === 47
    );
    expect(prClassification!.category).toBe("ci_real_failure");
  });
});

/* ── Category 4: cascade_duplicate ── */

describe("classifySnapshot — cascade_duplicate", () => {
  it("classifies duplicate issues with same error signature as cascade_duplicate", () => {
    // ratibot #120, #121 — cascade duplicate (zombie agent)
    const issue120 = makeIssue(120, {
      last_error_excerpt: "zombie agent:running + status:blocked",
      error_category: "zombie",
    });
    const issue121 = makeIssue(121, {
      last_error_excerpt: "zombie agent:running + status:blocked",
      error_category: "zombie",
    });
    const snapshot = makeSnapshot([
      makeRepo("cenetex/ratibot", [issue120, issue121], []),
    ]);
    const result = classifySnapshot(snapshot);
    const c120 = result.classifications.find((c) => c.number === 120);
    const c121 = result.classifications.find((c) => c.number === 121);
    // The root (#120, lower number) is genuine (no other signal),
    // the duplicate (#121) is cascade_duplicate.
    expect(c121!.category).toBe("cascade_duplicate");
    expect(c120!.category).not.toBe("cascade_duplicate");
    expect(result.summary.cascade_duplicate).toBe(1);
  });
});

/* ── Category 5: genuine ── */

describe("classifySnapshot — genuine", () => {
  it("classifies an issue with no matching signals as genuine", () => {
    const issue = makeIssue(500, {
      last_error_excerpt: "TypeError: undefined is not a function at line 42",
      error_category: "code_error",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const result = classifySnapshot(snapshot);
    const c = result.classifications.find((c) => c.number === 500);
    expect(c!.category).toBe("genuine");
  });

  it("classifies a PR with no checks and no error as genuine", () => {
    const pr = makePR(600, {
      mergeable: false,
      check_runs_summary: {
        total: 0, failed: 0, pending: 0, passed: 0, failed_checks: [],
      },
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [], [pr])]);
    const result = classifySnapshot(snapshot);
    const c = result.classifications.find((c) => c.is_pr && c.number === 600);
    expect(c!.category).toBe("genuine");
  });
});

/* ── Determinism ── */

describe("determinism", () => {
  it("produces identical output for identical input", () => {
    const issue = makeIssue(42, {
      last_error_excerpt: "Insufficient credits: -4 available",
      error_category: "credit_exhaustion",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const a = classifySnapshot(snapshot);
    const b = classifySnapshot(snapshot);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ── Summary ── */

describe("summary", () => {
  it("counts all five categories", () => {
    const result = classifySnapshot(
      makeSnapshot([makeRepo("cenetex/agent", [makeIssue(1)], [makePR(2)])])
    );
    expect(Object.keys(result.summary)).toHaveLength(5);
    // Issue 1 and PR 2 both have no matching signals → genuine
    expect(result.summary.genuine).toBe(2);
  });
});

/* ── Past report accuracy ── */

describe("computeReportAccuracy", () => {
  it("grades a fake_failure prediction as correct when item is gone", () => {
    const previous: ClassifiedSnapshot = {
      snapshot_id: "prev",
      classified_at: "2026-09-06T21:00:00Z",
      classifications: [
        {
          repo_slug: "cenetex/agent",
          is_pr: false,
          number: 42,
          github_url: "https://github.com/cenetex/agent/issues/42",
          category: "fake_failure",
          reasoning: { summary: "test", signals: {} },
          classified_at: "2026-09-06T21:00:00Z",
        },
      ],
      summary: {
        fake_failure: 1, transient_retryable: 0, ci_real_failure: 0,
        cascade_duplicate: 0, genuine: 0,
      },
    };
    // Current snapshot: issue 42 is gone (merged/closed)
    const current = makeSnapshot([makeRepo("cenetex/agent", [], [])]);
    const acc = computeReportAccuracy(previous, current);
    expect(acc.total).toBe(1);
    expect(acc.correct).toBe(1);
    expect(acc.incorrect).toBe(0);
    expect(acc.false_positive_rate).toBe(0);
  });

  it("grades a fake_failure prediction as incorrect when item still present", () => {
    const previous: ClassifiedSnapshot = {
      snapshot_id: "prev",
      classified_at: "2026-09-06T21:00:00Z",
      classifications: [
        {
          repo_slug: "cenetex/agent",
          is_pr: false,
          number: 42,
          github_url: "https://github.com/cenetex/agent/issues/42",
          category: "fake_failure",
          reasoning: { summary: "test", signals: {} },
          classified_at: "2026-09-06T21:00:00Z",
        },
      ],
      summary: {
        fake_failure: 1, transient_retryable: 0, ci_real_failure: 0,
        cascade_duplicate: 0, genuine: 0,
      },
    };
    const current = makeSnapshot([
      makeRepo("cenetex/agent", [makeIssue(42)], []),
    ]);
    const acc = computeReportAccuracy(previous, current);
    expect(acc.correct).toBe(0);
    expect(acc.incorrect).toBe(1);
    expect(acc.false_positive_rate).toBe(1);
  });
});

/* ── Daily health report ── */

describe("buildDailyHealthReport", () => {
  it("produces a report with null accuracy when no prior report", () => {
    const issue = makeIssue(42, {
      last_error_excerpt: "timeout",
      error_category: "timeout",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const classified = classifySnapshot(snapshot);
    const report = buildDailyHealthReport(classified, null, snapshot);
    expect(report.report_date).toBe("2026-09-07");
    expect(report.past_report_accuracy).toBeNull();
    expect(report.total_items).toBe(1);
  });

  it("produces a report with accuracy section when prior report exists", () => {
    const issue = makeIssue(42, {
      last_error_excerpt: "timeout",
      error_category: "timeout",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const classified = classifySnapshot(snapshot);
    const previous: ClassifiedSnapshot = {
      snapshot_id: "prev",
      classified_at: "2026-09-06T21:00:00Z",
      classifications: [
        {
          repo_slug: "cenetex/agent",
          is_pr: false,
          number: 42,
          github_url: "",
          category: "genuine",
          reasoning: { summary: "", signals: {} },
          classified_at: "2026-09-06T21:00:00Z",
        },
      ],
      summary: {
        fake_failure: 0, transient_retryable: 0, ci_real_failure: 0,
        cascade_duplicate: 0, genuine: 1,
      },
    };
    const report = buildDailyHealthReport(classified, previous, snapshot);
    expect(report.past_report_accuracy).not.toBeNull();
    expect(report.past_report_accuracy!.prior_date).toBe("2026-09-06");
    expect(report.past_report_accuracy!.total).toBe(1);
  });
});

/* ── Markdown rendering ── */

describe("renderHealthReportMarkdown", () => {
  it("renders a markdown report with all sections", () => {
    const issue = makeIssue(42, {
      last_error_excerpt: "timeout",
      error_category: "timeout",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const classified = classifySnapshot(snapshot);
    const report = buildDailyHealthReport(classified, null, snapshot);
    const md = renderHealthReportMarkdown(report);
    expect(md).toContain("# Unblocker Health Report");
    expect(md).toContain("## Summary by category");
    expect(md).toContain("## Past report accuracy");
    expect(md).toContain("## Classified items");
  });

  it("renders accuracy table when prior report exists", () => {
    const issue = makeIssue(42, {
      last_error_excerpt: "timeout",
      error_category: "timeout",
    });
    const snapshot = makeSnapshot([makeRepo("cenetex/agent", [issue], [])]);
    const classified = classifySnapshot(snapshot);
    const previous: ClassifiedSnapshot = {
      snapshot_id: "prev",
      classified_at: "2026-09-06T21:00:00Z",
      classifications: [
        {
          repo_slug: "cenetex/agent",
          is_pr: false,
          number: 42,
          github_url: "",
          category: "genuine",
          reasoning: { summary: "", signals: {} },
          classified_at: "2026-09-06T21:00:00Z",
        },
      ],
      summary: {
        fake_failure: 0, transient_retryable: 0, ci_real_failure: 0,
        cascade_duplicate: 0, genuine: 1,
      },
    };
    const report = buildDailyHealthReport(classified, previous, snapshot);
    const md = renderHealthReportMarkdown(report);
    expect(md).toContain("False-positive rate:");
    expect(md).toContain("genuine");
  });
});

/* ── Multi-repo integration ── */

describe("classifySnapshot — multi-repo integration", () => {
  it("classifies a mixed snapshot with all five categories", () => {
    // Fake failure: issue 10 fixed by PR 11 (green)
    const fakeIssue = makeIssue(10);
    const fakePR = makePR(11, {
      mergeable: true,
      check_runs_summary: {
        total: 2, failed: 0, pending: 0, passed: 2, failed_checks: [],
      },
    });
    const fakeXref: CrossReference = {
      type: "fixes",
      from: { issue_number: 11, repo: "cenetex/agent", is_pr: true },
      to: { issue_number: 10, repo: "cenetex/agent" },
    };

    // CI-real: issue 20 fixed by PR 21 (lint failed)
    const ciIssue = makeIssue(20);
    const ciPR = makePR(21, {
      mergeable: true,
      check_runs_summary: {
        total: 2, failed: 1, pending: 0, passed: 1, failed_checks: ["lint"],
      },
    });
    const ciXref: CrossReference = {
      type: "fixes",
      from: { issue_number: 21, repo: "cenetex/agent", is_pr: true },
      to: { issue_number: 20, repo: "cenetex/agent" },
    };

    // Transient: issue 30
    const transientIssue = makeIssue(30, {
      last_error_excerpt: "OpenRouter 402 payment required",
      error_category: "credit_exhaustion",
    });

    // Cascade: issues 40, 41 same signature
    const cascadeRoot = makeIssue(40, {
      last_error_excerpt: "zombie agent stuck",
      error_category: "zombie",
    });
    const cascadeDup = makeIssue(41, {
      last_error_excerpt: "zombie agent stuck",
      error_category: "zombie",
    });

    // Genuine: issue 50
    const genuineIssue = makeIssue(50, {
      last_error_excerpt: "TypeError: x is undefined",
      error_category: "code_error",
    });

    const snapshot = makeSnapshot([
      makeRepo("cenetex/agent", [
        fakeIssue, ciIssue, transientIssue, cascadeRoot, cascadeDup, genuineIssue,
      ], [fakePR, ciPR], [fakeXref, ciXref]),
    ]);

    const result = classifySnapshot(snapshot);
    const categories = result.classifications.map((c) => c.category);
    expect(categories).toContain("fake_failure");
    expect(categories).toContain("transient_retryable");
    expect(categories).toContain("ci_real_failure");
    expect(categories).toContain("cascade_duplicate");
    expect(categories).toContain("genuine");
    expect(result.classifications).toHaveLength(8); // 6 issues + 2 PRs
  });
});
