/**
 * Tests for the unblocker escalation queue (issue #390).
 *
 * Tests the pure queue logic (addEscalation, isEscalated, resolveEscalation,
 * pruneResolved, getOverdueEscalations, computeGenuinePersisting,
 * parsePinnedIssueBody, renderPinnedIssueBody, renderEscalationSection)
 * and the webhook no-op behavior.
 */

import {
  addEscalation,
  isEscalated,
  hasEscalationEntry,
  resolveEscalation,
  pruneResolved,
  getOverdueEscalations,
  computeGenuinePersisting,
  parsePinnedIssueBody,
  renderPinnedIssueBody,
  renderEscalationSection,
  getPinnedIssueUrl,
  sendEscalationWebhook,
  ESCALATION_SECTION_START,
  ESCALATION_SECTION_END,
  type EscalationQueue,
  type EscalationEntry,
} from "../lib/unblocker/escalation";

// ---------------------------------------------------------------------------
// Mock AWS SDK + global fetch so the I/O functions don't hit the network
// ---------------------------------------------------------------------------

const mockS3Send = jest.fn();
const mockSsmSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: (...args: any[]) => mockS3Send(...args) })),
  GetObjectCommand: jest.fn().mockImplementation((input: any) => input),
  PutObjectCommand: jest.fn().mockImplementation((input: any) => input),
}));
jest.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: (...args: any[]) => mockSsmSend(...args) })),
  GetParameterCommand: jest.fn().mockImplementation((input: any) => input),
}));
jest.mock("../lib/types", () => ({
  ...jest.requireActual("../lib/types"),
  getInstallationToken: jest.fn().mockResolvedValue("mock-token"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<EscalationEntry> = {}): EscalationEntry {
  return {
    repo_slug: "owner/repo",
    number: 42,
    is_pr: false,
    github_url: "https://github.com/owner/repo/issues/42",
    root_cause_hypothesis: "timeout in CI",
    what_was_tried: "Dispatcher retried 3 times in 24h.",
    recommended_action: "Investigate CI timeout configuration.",
    escalated_at: new Date("2026-09-01T00:00:00Z").toISOString(),
    last_attempt_count: 3,
    state: "escalated",
    ...overrides,
  };
}

function makeQueue(entries: EscalationEntry[] = []): EscalationQueue {
  return {
    entries,
    pinned_issue_number: entries.length > 0 ? 999 : null,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queue logic
// ---------------------------------------------------------------------------

describe("escalation queue — addEscalation", () => {
  it("adds a new entry to an empty queue", () => {
    const queue = makeQueue();
    const { queue: updated, added } = addEscalation(queue, {
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      last_attempt_count: 3,
    });
    expect(added).toBe(true);
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].state).toBe("escalated");
  });

  it("does not re-add an already-escalated item", () => {
    const entry = makeEntry();
    const queue = makeQueue([entry]);
    const { queue: updated, added } = addEscalation(queue, {
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      last_attempt_count: 3,
    });
    expect(added).toBe(false);
    expect(updated.entries).toHaveLength(1);
  });

  it("re-escalates a previously resolved item (removes old entry first)", () => {
    const resolved = makeEntry({ state: "resolved" });
    const queue = makeQueue([resolved]);
    const { queue: updated, added } = addEscalation(queue, {
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      last_attempt_count: 4,
    });
    expect(added).toBe(true);
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].state).toBe("escalated");
  });
});

describe("escalation queue — isEscalated / hasEscalationEntry", () => {
  it("isEscalated returns true for an escalated item", () => {
    const queue = makeQueue([makeEntry()]);
    expect(isEscalated(queue, "owner/repo", 42)).toBe(true);
  });

  it("isEscalated returns false for a resolved item", () => {
    const queue = makeQueue([makeEntry({ state: "resolved" })]);
    expect(isEscalated(queue, "owner/repo", 42)).toBe(false);
  });

  it("isEscalated returns false for a non-existent item", () => {
    const queue = makeQueue([makeEntry()]);
    expect(isEscalated(queue, "owner/repo", 99)).toBe(false);
  });

  it("hasEscalationEntry returns true for resolved entries too", () => {
    const queue = makeQueue([makeEntry({ state: "resolved" })]);
    expect(hasEscalationEntry(queue, "owner/repo", 42)).toBe(true);
  });
});

describe("escalation queue — resolveEscalation", () => {
  it("marks an escalated entry as resolved", () => {
    const queue = makeQueue([makeEntry()]);
    const resolved = resolveEscalation(queue, "owner/repo", 42);
    expect(resolved.entries[0].state).toBe("resolved");
  });

  it("leaves other entries unchanged", () => {
    const queue = makeQueue([
      makeEntry({ number: 42 }),
      makeEntry({ number: 43, state: "escalated" }),
    ]);
    const resolved = resolveEscalation(queue, "owner/repo", 42);
    expect(resolved.entries[0].state).toBe("resolved");
    expect(resolved.entries[1].state).toBe("escalated");
  });
});

describe("escalation queue — pruneResolved", () => {
  it("removes resolved entries older than 7 days", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const queue = makeQueue([
      makeEntry({ state: "resolved", escalated_at: oldDate }),
      makeEntry({ number: 43, state: "resolved", escalated_at: new Date().toISOString() }),
    ]);
    const pruned = pruneResolved(queue);
    expect(pruned.entries).toHaveLength(1);
    expect(pruned.entries[0].number).toBe(43);
  });

  it("keeps escalated entries regardless of age", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const queue = makeQueue([makeEntry({ escalated_at: oldDate })]);
    const pruned = pruneResolved(queue);
    expect(pruned.entries).toHaveLength(1);
  });
});

describe("escalation queue — getOverdueEscalations", () => {
  it("returns escalations older than 7 days", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const queue = makeQueue([
      makeEntry({ escalated_at: oldDate }),
      makeEntry({ number: 43, escalated_at: new Date().toISOString() }),
    ]);
    const overdue = getOverdueEscalations(queue);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].number).toBe(42);
  });

  it("returns empty when all escalations are recent", () => {
    const queue = makeQueue([makeEntry({ escalated_at: new Date().toISOString() })]);
    expect(getOverdueEscalations(queue)).toHaveLength(0);
  });

  it("excludes resolved entries", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const queue = makeQueue([makeEntry({ state: "resolved", escalated_at: oldDate })]);
    expect(getOverdueEscalations(queue)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Genuine persistence
// ---------------------------------------------------------------------------

describe("computeGenuinePersisting", () => {
  it("returns items that persisted across 3+ reports", () => {
    const current = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const previous1 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const previous2 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const result = computeGenuinePersisting(current, [previous1, previous2]);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(50);
    expect(result[0].consecutive_reports).toBe(3);
  });

  it("does not escalate items that appeared fewer than threshold times", () => {
    const current = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const previous1 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const result = computeGenuinePersisting(current, [previous1]);
    expect(result).toHaveLength(0);
  });

  it("ignores non-genuine categories", () => {
    const current = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "transient_retryable" },
    ];
    const previous1 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "transient_retryable" },
    ];
    const previous2 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "transient_retryable" },
    ];
    const result = computeGenuinePersisting(current, [previous1, previous2]);
    expect(result).toHaveLength(0);
  });

  it("respects custom threshold", () => {
    const current = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const previous1 = [
      { repo_slug: "owner/repo", number: 50, is_pr: false, category: "genuine" },
    ];
    const result = computeGenuinePersisting(current, [previous1], 2);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pinned issue body parsing & rendering
// ---------------------------------------------------------------------------

describe("parsePinnedIssueBody", () => {
  it("parses a valid JSON section between markers", () => {
    const entries = [makeEntry()];
    const body = `Some intro text\n\n${ESCALATION_SECTION_START}\n${JSON.stringify(entries, null, 2)}\n${ESCALATION_SECTION_END}\n`;
    const parsed = parsePinnedIssueBody(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].number).toBe(42);
  });

  it("returns empty array when markers are missing", () => {
    expect(parsePinnedIssueBody("no markers here")).toEqual([]);
  });

  it("returns empty array when JSON is invalid", () => {
    const body = `${ESCALATION_SECTION_START}\nnot valid json\n${ESCALATION_SECTION_END}`;
    expect(parsePinnedIssueBody(body)).toEqual([]);
  });

  it("returns empty array when section is empty", () => {
    const body = `${ESCALATION_SECTION_START}\n[]\n${ESCALATION_SECTION_END}`;
    expect(parsePinnedIssueBody(body)).toEqual([]);
  });
});

describe("renderPinnedIssueBody", () => {
  it("renders a body with the title and markers", () => {
    const queue = makeQueue([makeEntry()]);
    const body = renderPinnedIssueBody(queue);
    expect(body).toContain("Unblocker Escalations");
    expect(body).toContain(ESCALATION_SECTION_START);
    expect(body).toContain(ESCALATION_SECTION_END);
  });

  it("renders _No active escalations._ when queue is empty", () => {
    const queue = makeQueue([]);
    const body = renderPinnedIssueBody(queue);
    expect(body).toContain("_No active escalations._");
  });

  it("includes the JSON array between markers for machine parsing", () => {
    const queue = makeQueue([makeEntry()]);
    const body = renderPinnedIssueBody(queue);
    const parsed = parsePinnedIssueBody(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].number).toBe(42);
  });

  it("only renders escalated entries (not resolved)", () => {
    const queue = makeQueue([
      makeEntry({ number: 42 }),
      makeEntry({ number: 43, state: "resolved" }),
    ]);
    const body = renderPinnedIssueBody(queue);
    const parsed = parsePinnedIssueBody(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].number).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Escalation section for daily report
// ---------------------------------------------------------------------------

describe("renderEscalationSection", () => {
  it("renders the Escalations section with a table", () => {
    const queue = makeQueue([makeEntry()]);
    const md = renderEscalationSection(queue, "owner/repo");
    expect(md).toContain("## Escalations");
    expect(md).toContain("| Repo | Item | Root cause |");
    expect(md).toContain("owner/repo");
  });

  it("includes the pinned issue URL", () => {
    const queue = makeQueue([makeEntry()]);
    const md = renderEscalationSection(queue, "owner/repo");
    expect(md).toContain("Pinned escalation issue");
  });

  it("returns empty string when no escalations and no pinned issue", () => {
    const queue: EscalationQueue = {
      entries: [],
      pinned_issue_number: null,
      updated_at: new Date().toISOString(),
    };
    expect(renderEscalationSection(queue, "owner/repo")).toBe("");
  });

  it("nags overdue escalations at the top with severity", () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const queue = makeQueue([makeEntry({ escalated_at: oldDate })]);
    const md = renderEscalationSection(queue, "owner/repo");
    expect(md).toContain("⚠️");
    expect(md).toContain("needs immediate attention");
  });
});

describe("getPinnedIssueUrl", () => {
  it("returns the URL when pinned issue exists", () => {
    const queue = makeQueue([makeEntry()]);
    expect(getPinnedIssueUrl(queue, "owner/repo")).toBe(
      "https://github.com/owner/repo/issues/999"
    );
  });

  it("returns null when no pinned issue", () => {
    const queue: EscalationQueue = {
      entries: [],
      pinned_issue_number: null,
      updated_at: new Date().toISOString(),
    };
    expect(getPinnedIssueUrl(queue, "owner/repo")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

describe("sendEscalationWebhook", () => {
  const originalEnv = process.env.UNBLOCKER_ESCALATION_WEBHOOK;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.UNBLOCKER_ESCALATION_WEBHOOK;
    } else {
      process.env.UNBLOCKER_ESCALATION_WEBHOOK = originalEnv;
    }
  });

  it("no-ops when UNBLOCKER_ESCALATION_WEBHOOK is not set", async () => {
    delete process.env.UNBLOCKER_ESCALATION_WEBHOOK;
    const result = await sendEscalationWebhook({
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      escalated_at: new Date().toISOString(),
      attempt_count: 3,
      escalation_issue_url: null,
    });
    expect(result).toBe(false);
  });

  it("sends a POST when UNBLOCKER_ESCALATION_WEBHOOK is set", async () => {
    process.env.UNBLOCKER_ESCALATION_WEBHOOK = "https://example.com/hook";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 })
    );
    const result = await sendEscalationWebhook({
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      escalated_at: new Date().toISOString(),
      attempt_count: 3,
      escalation_issue_url: null,
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({ method: "POST" })
    );
    fetchSpy.mockRestore();
  });

  it("returns false on webhook failure", async () => {
    process.env.UNBLOCKER_ESCALATION_WEBHOOK = "https://example.com/hook";
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 })
    );
    const result = await sendEscalationWebhook({
      repo_slug: "owner/repo",
      number: 42,
      is_pr: false,
      github_url: "https://github.com/owner/repo/issues/42",
      root_cause_hypothesis: "timeout",
      what_was_tried: "retried 3x",
      recommended_action: "check CI",
      escalated_at: new Date().toISOString(),
      attempt_count: 3,
      escalation_issue_url: null,
    });
    expect(result).toBe(false);
    fetchSpy.mockRestore();
  });
});
