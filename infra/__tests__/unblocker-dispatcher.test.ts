/**
 * Tests for the unblocker action dispatcher (issue #389).
 *
 * Each action path is tested with a mocked GitHub API (global.fetch) and
 * mocked AWS SDK clients. The pure dispatching logic is exercised through
 * the exported helper functions and dispatchSnapshot.
 */

import {
  ClassifiedItem,
  ClassifiedSnapshot,
  handleFakeFailure,
  handleTransientRetryable,
  handleCiRealFailure,
  handleCascadeDuplicate,
  handleGenuine,
  dispatchSnapshot,
  readLoopTracker,
  recordPass,
  isRepoEnabled,
} from "../lib/unblocker/dispatcher";

// ---------------------------------------------------------------------------
// Mock AWS SDK clients
// ---------------------------------------------------------------------------

const mockS3Send = jest.fn();
const mockSsmSend = jest.fn();
const mockCwSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input: any) => input),
  PutObjectCommand: jest.fn().mockImplementation((input: any) => input),
  ListObjectsV2Command: jest.fn().mockImplementation((input: any) => input),
}));
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input: any) => input),
}));
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCwSend })),
}));

// Mock getInstallationToken so dispatchSnapshot's tokenResolver works.
jest.mock("../lib/types", () => ({
  ...jest.requireActual("../lib/types"),
  getInstallationToken: jest.fn().mockResolvedValue("mock-token"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGithubResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function captureFetchCalls(fetchMock: jest.SpyInstance): Array<{ url: string; method: string; body: any }> {
  return fetchMock.mock.calls.map((call: any[]) => {
    const url = call[0] as string;
    const init = (call[1] || {}) as RequestInit;
    let body: any = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    return { url, method: init.method ?? "GET", body };
  });
}

function makeItem(overrides: Partial<ClassifiedItem> = {}): ClassifiedItem {
  return {
    repo_slug: "owner/repo",
    number: 42,
    is_pr: true,
    title: "Test PR",
    github_url: "https://github.com/owner/repo/pull/42",
    classification: "fake_failure",
    head_sha: "abc123",
    mergeable: true,
    check_runs_summary: {
      total: 3,
      failed: 0,
      pending: 0,
      passed: 3,
      failed_checks: [],
    },
    rationale: null,
    last_updated: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeBudget() {
  return { merges: 0, labelChanges: 0, issueCreations: 0, exceeded: false };
}

// S3 GetObject returns a body that can be read via transformToString.
function mockS3GetObjectBody(key: string, content: string | null): void {
  mockS3Send.mockImplementationOnce(async (cmd: any) => {
    if (cmd.Key === key) {
      if (content === null) {
        const err = new Error("NoSuchKey");
        (err as any).name = "NoSuchKey";
        throw err;
      }
      return {
        Body: { transformToString: async () => content },
      };
    }
    const err = new Error("NoSuchKey");
    (err as any).name = "NoSuchKey";
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unblocker dispatcher", () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      mockGithubResponse({})
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Genuine (no-op)
  // -----------------------------------------------------------------------
  describe("genuine classification", () => {
    it("produces a no-op action", () => {
      const item = makeItem({ classification: "genuine" });
      const action = handleGenuine(item, false);
      expect(action.action).toBe("noop");
      expect(action.classification).toBe("genuine");
      expect(action.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fake failure
  // -----------------------------------------------------------------------
  describe("fake failure action path", () => {
    it("merges PR and closes issue when checks green and hold elapsed", async () => {
      const item = makeItem({ classification: "fake_failure", is_pr: true });
      fetchMock.mockResolvedValue(mockGithubResponse({ merged: true, sha: "deadbeef" }, 200));

      const actions = await handleFakeFailure(item, "token", false, makeBudget(), 10);

      const merge = actions.find((a) => a.action === "merge_pr");
      const close = actions.find((a) => a.action === "close");
      expect(merge?.success).toBe(true);
      expect(close?.success).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      expect(calls.some((c) => c.url.includes("/pulls/42/merge") && c.method === "PUT")).toBe(true);
      expect(calls.some((c) => c.url.includes("/issues/42") && c.method === "PATCH" && c.body?.state === "closed")).toBe(true);
    });

    it("skips merge when checks are not green", async () => {
      const item = makeItem({
        classification: "fake_failure",
        check_runs_summary: { total: 3, failed: 1, pending: 0, passed: 2, failed_checks: ["lint"] },
      });

      const actions = await handleFakeFailure(item, "token", false, makeBudget(), 10);
      expect(actions).toHaveLength(1);
      expect(actions[0].action).toBe("noop");
    });

    it("waits when hold period not elapsed", async () => {
      const item = makeItem({
        classification: "fake_failure",
        last_updated: new Date().toISOString(),
      });

      const actions = await handleFakeFailure(item, "token", false, makeBudget(), 10);
      expect(actions[0].action).toBe("hold");
    });

    it("dry-run posts a comment without mutating", async () => {
      const item = makeItem({ classification: "fake_failure" });
      const actions = await handleFakeFailure(item, "token", true, makeBudget(), 10);

      const merge = actions.find((a) => a.action === "merge_pr");
      expect(merge?.dry_run).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      // Should only have posted a comment, not merged.
      expect(calls.some((c) => c.method === "PUT" && c.url.includes("/merge"))).toBe(false);
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/comments"))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Transient retryable
  // -----------------------------------------------------------------------
  describe("transient retryable action path", () => {
    it("re-adds agent label on first pass (no backoff)", async () => {
      const item = makeItem({ classification: "transient_retryable" });
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/42.json", null);

      const actions = await handleTransientRetryable(item, "token", false, makeBudget());
      const label = actions.find((a) => a.action === "add_label");
      expect(label?.success).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      expect(calls.some((c) => c.url.includes("/issues/42/labels") && c.method === "POST" && c.body?.labels?.includes("agent"))).toBe(true);
    });

    it("respects exponential backoff on subsequent passes", async () => {
      const recentPass = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
      mockS3GetObjectBody(
        "unblocker/loop-tracker/owner/repo/42.json",
        JSON.stringify({ repo_slug: "owner/repo", number: 42, passes: [recentPass], frozen: false, updated_at: recentPass })
      );

      const item = makeItem({ classification: "transient_retryable" });
      const actions = await handleTransientRetryable(item, "token", false, makeBudget());
      expect(actions[0].action).toBe("backoff");
    });

    it("escalates after max retries exceeded", async () => {
      const oldPasses = [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 55 * 60 * 1000).toISOString(),
        new Date(Date.now() - 50 * 60 * 1000).toISOString(),
        new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      ];
      mockS3GetObjectBody(
        "unblocker/loop-tracker/owner/repo/42.json",
        JSON.stringify({ repo_slug: "owner/repo", number: 42, passes: oldPasses, frozen: false, updated_at: oldPasses[3] })
      );

      const item = makeItem({ classification: "transient_retryable" });
      const actions = await handleTransientRetryable(item, "token", false, makeBudget());
      expect(actions[0].action).toBe("noop");
      expect(actions[0].message).toContain("Max transient retries");
    });

    it("dry-run does not add label", async () => {
      const item = makeItem({ classification: "transient_retryable" });
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/42.json", null);

      const actions = await handleTransientRetryable(item, "token", true, makeBudget());
      const label = actions.find((a) => a.action === "add_label");
      expect(label?.dry_run).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      // Only the dry-run comment, not the label POST.
      expect(calls.some((c) => c.url.includes("/labels") && c.method === "POST")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // CI-real failure
  // -----------------------------------------------------------------------
  describe("ci-real failure action path", () => {
    it("creates a follow-up issue and re-adds agent label", async () => {
      const item = makeItem({
        classification: "ci_real_failure",
        check_runs_summary: { total: 2, failed: 1, pending: 0, passed: 1, failed_checks: ["lint"] },
      });
      fetchMock
        .mockResolvedValueOnce(mockGithubResponse({ number: 99 }, 201))
        .mockResolvedValueOnce(mockGithubResponse({}, 200));

      const actions = await handleCiRealFailure(item, "token", false, makeBudget());
      const create = actions.find((a) => a.action === "create_issue");
      const label = actions.find((a) => a.action === "add_label");
      expect(create?.success).toBe(true);
      expect(label?.success).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      expect(calls.some((c) => c.url.includes("/repos/owner/repo/issues") && c.method === "POST" && c.body?.labels?.includes("agent"))).toBe(true);
    });

    it("dry-run does not create issue", async () => {
      const item = makeItem({ classification: "ci_real_failure" });
      const actions = await handleCiRealFailure(item, "token", true, makeBudget());
      const create = actions.find((a) => a.action === "create_issue");
      expect(create?.dry_run).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/repos/owner/repo/issues"))).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Cascade duplicate
  // -----------------------------------------------------------------------
  describe("cascade duplicate action path", () => {
    it("picks most-recent as representative and closes others", async () => {
      const items = [
        makeItem({ number: 10, classification: "cascade_duplicate", last_updated: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
        makeItem({ number: 11, classification: "cascade_duplicate", last_updated: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
        makeItem({ number: 12, classification: "cascade_duplicate", last_updated: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
      ];
      fetchMock.mockResolvedValue(mockGithubResponse({}));

      const actions = await handleCascadeDuplicate(items, "token", false, makeBudget());
      const closes = actions.filter((a) => a.action === "close");
      expect(closes).toHaveLength(2);
      const closedNumbers = closes.map((a) => a.number).sort((a, b) => a - b);
      expect(closedNumbers).toEqual([10, 11]);

      const calls = captureFetchCalls(fetchMock);
      // Should have posted linking comments and PATCHed to close.
      expect(calls.filter((c) => c.method === "PATCH" && c.body?.state === "closed").length).toBe(2);
    });

    it("does nothing for a single item", async () => {
      const actions = await handleCascadeDuplicate([makeItem({ classification: "cascade_duplicate" })], "token", false, makeBudget());
      expect(actions).toHaveLength(0);
    });

    it("dry-run does not close duplicates", async () => {
      const items = [
        makeItem({ number: 10, classification: "cascade_duplicate", last_updated: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
        makeItem({ number: 11, classification: "cascade_duplicate", last_updated: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
      ];
      const actions = await handleCascadeDuplicate(items, "token", true, makeBudget());
      const closes = actions.filter((a) => a.action === "close");
      expect(closes).toHaveLength(1);
      expect(closes[0].dry_run).toBe(true);

      const calls = captureFetchCalls(fetchMock);
      expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Loop detection
  // -----------------------------------------------------------------------
  describe("loop detection", () => {
    it("writes loop tracker to S3 at unblocker/loop-tracker/{repo}/{number}.json", async () => {
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/42.json", null);

      const { frozen } = await recordPass("owner/repo", 42);
      expect(frozen).toBe(false);

      const putWithKey = mockS3Send.mock.calls.find((call: any[]) => call[0]?.Key === "unblocker/loop-tracker/owner/repo/42.json");
      expect(putWithKey).toBeDefined();
    });

    it("freezes after more than 3 passes in 24h", async () => {
      const passes = [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 55 * 60 * 1000).toISOString(),
        new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      ];
      mockS3GetObjectBody(
        "unblocker/loop-tracker/owner/repo/42.json",
        JSON.stringify({ repo_slug: "owner/repo", number: 42, passes, frozen: false, updated_at: passes[2] })
      );

      const { frozen } = await recordPass("owner/repo", 42);
      expect(frozen).toBe(true);
    });

    it("purges passes older than 24h", async () => {
      const oldPass = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const recentPass = new Date(Date.now() - 60 * 1000).toISOString();
      mockS3GetObjectBody(
        "unblocker/loop-tracker/owner/repo/42.json",
        JSON.stringify({ repo_slug: "owner/repo", number: 42, passes: [oldPass, recentPass], frozen: false, updated_at: recentPass })
      );

      const entry = await readLoopTracker("owner/repo", 42);
      expect(entry.passes).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Per-repo enable flag
  // -----------------------------------------------------------------------
  describe("per-repo enable flag", () => {
    it("returns true when unblocker:enabled label exists", async () => {
      fetchMock.mockResolvedValue(mockGithubResponse({}, 200));
      const enabled = await isRepoEnabled("owner/repo", "token");
      expect(enabled).toBe(true);
    });

    it("returns false by default (no label, no UNBLOCKER.md)", async () => {
      fetchMock
        .mockResolvedValueOnce(mockGithubResponse({}, 404)) // label
        .mockResolvedValueOnce(mockGithubResponse({}, 404)); // UNBLOCKER.md
      const enabled = await isRepoEnabled("owner/repo", "token");
      expect(enabled).toBe(false);
    });

    it("returns true when .github/UNBLOCKER.md exists", async () => {
      fetchMock
        .mockResolvedValueOnce(mockGithubResponse({}, 404)) // label
        .mockResolvedValueOnce(mockGithubResponse("# unblocker", 200)); // UNBLOCKER.md
      const enabled = await isRepoEnabled("owner/repo", "token");
      expect(enabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Action budget
  // -----------------------------------------------------------------------
  describe("action budget", () => {
    it("hard stops merges at 5", async () => {
      const budget = { merges: 5, labelChanges: 0, issueCreations: 0, exceeded: false };
      const item = makeItem({ classification: "fake_failure" });
      const actions = await handleFakeFailure(item, "token", false, budget, 10);
      const merge = actions.find((a) => a.action === "merge_pr");
      expect(merge).toBeUndefined();
      expect(budget.exceeded).toBe(true);
    });

    it("hard stops label changes at 10", async () => {
      const budget = { merges: 0, labelChanges: 10, issueCreations: 0, exceeded: false };
      const item = makeItem({ classification: "transient_retryable" });
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/42.json", null);
      const actions = await handleTransientRetryable(item, "token", false, budget);
      const label = actions.find((a) => a.action === "add_label");
      expect(label).toBeUndefined();
      expect(budget.exceeded).toBe(true);
    });

    it("hard stops issue creations at 5", async () => {
      const budget = { merges: 0, labelChanges: 0, issueCreations: 5, exceeded: false };
      const item = makeItem({ classification: "ci_real_failure" });
      const actions = await handleCiRealFailure(item, "token", false, budget);
      const create = actions.find((a) => a.action === "create_issue");
      expect(create?.success).toBe(false);
      expect(budget.exceeded).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // dispatchSnapshot integration
  // -----------------------------------------------------------------------
  describe("dispatchSnapshot", () => {
    function makeSnapshot(items: ClassifiedItem[]): ClassifiedSnapshot {
      return {
        snapshot_id: "snap-1",
        classified_at: new Date().toISOString(),
        repos: { "owner/repo": { items } },
      };
    }

    it("dry-run by default (repo not enabled) produces would-do comments", async () => {
      const snapshot = makeSnapshot([
        makeItem({ classification: "fake_failure", is_pr: true }),
        makeItem({ classification: "genuine", number: 50 }),
      ]);
      fetchMock.mockResolvedValue(mockGithubResponse({}));
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/42.json", null);
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/50.json", null);

      const result = await dispatchSnapshot(
        snapshot,
        async () => "token",
        async () => false,
        10
      );

      const dryRunActions = result.actions.filter((a) => a.dry_run);
      expect(dryRunActions.length).toBeGreaterThan(0);
      const calls = captureFetchCalls(fetchMock);
      // No mutations in dry-run mode.
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      expect(calls.some((c) => c.method === "PATCH" && c.body?.state === "closed")).toBe(false);
    });

    it("mutates when repo is enabled", async () => {
      const snapshot = makeSnapshot([
        makeItem({ classification: "transient_retryable", is_pr: false, number: 30 }),
      ]);
      fetchMock.mockResolvedValue(mockGithubResponse({}, 200));
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/30.json", null);

      const result = await dispatchSnapshot(
        snapshot,
        async () => "token",
        async () => true,
        10
      );

      const label = result.actions.find((a) => a.action === "add_label");
      expect(label?.dry_run).toBe(false);
      expect(label?.success).toBe(true);
    });

    it("publishes CloudWatch metric UnblockerDispatcher.ActionsByCategory", async () => {
      const snapshot = makeSnapshot([makeItem({ classification: "genuine", number: 60 })]);
      mockS3GetObjectBody("unblocker/loop-tracker/owner/repo/60.json", null);

      await dispatchSnapshot(snapshot, async () => "token", async () => false, 10);

      expect(mockCwSend).toHaveBeenCalled();
      const metricCall = mockCwSend.mock.calls[0][0];
      expect(metricCall.Namespace).toBe("UnblockerDispatcher");
      expect(metricCall.MetricData.some((m: any) => m.MetricName === "ActionsByCategory")).toBe(true);
    });

    it("freezes items that exceed loop threshold", async () => {
      const passes = [
        new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        new Date(Date.now() - 55 * 60 * 1000).toISOString(),
        new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      ];
      mockS3GetObjectBody(
        "unblocker/loop-tracker/owner/repo/42.json",
        JSON.stringify({ repo_slug: "owner/repo", number: 42, passes, frozen: false, updated_at: passes[2] })
      );

      const snapshot = makeSnapshot([makeItem({ classification: "transient_retryable" })]);
      const result = await dispatchSnapshot(snapshot, async () => "token", async () => true, 10);

      const freeze = result.actions.find((a) => a.action === "freeze");
      expect(freeze).toBeDefined();
    });
  });
});
