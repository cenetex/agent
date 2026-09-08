import {
  verifyDiagnosticReport,
  isOperatorEvidenceTool,
  REPORT_SECTIONS,
  type DiagnosticReport,
  type VerifiedEntry,
} from "../lib/diagnostic-report";

function validReport(): DiagnosticReport {
  return {
    task_id: "task_test_abc",
    observed: "Canary task exited with code 1 at 2026-09-07T10:00:00Z",
    verified: [
      {
        claim: "Canary task failed due to OOM",
        evidence: [
          {
            tool: "logs.read",
            artifact: "log-event:aws/ecs/canary/stream-123#event-456",
            summary: "Container exited withOutOfMemoryError",
          },
        ],
      },
    ],
    suspected: "Memory limit may be too low for the canary workload",
    unknown: "Whether the QA task also fails with OOM under load",
    recommended: "Increase the canary task memory limit to 4096 MiB and re-run",
  };
}

describe("diagnostic-report — REPORT_SECTIONS", () => {
  it("declares all five required sections", () => {
    expect(REPORT_SECTIONS).toEqual([
      "observed",
      "verified",
      "suspected",
      "unknown",
      "recommended",
    ]);
  });
});

describe("diagnostic-report — verifyDiagnosticReport", () => {
  it("passes a valid report", () => {
    const result = verifyDiagnosticReport(validReport());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when observed is missing", () => {
    const report = validReport();
    (report as any).observed = "";
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("observed");
  });

  it("fails when suspected is missing", () => {
    const report = validReport();
    (report as any).suspected = "";
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("suspected");
  });

  it("fails when unknown is missing", () => {
    const report = validReport();
    (report as any).unknown = "";
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("unknown");
  });

  it("fails when recommended is missing", () => {
    const report = validReport();
    (report as any).recommended = "";
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("recommended");
  });

  it("fails when verified section is empty", () => {
    const report = validReport();
    report.verified = [];
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("verified");
  });

  it("fails when verified entry claims verification without evidence reference", () => {
    const report = validReport();
    report.verified = [
      { claim: "Canary failed", evidence: [] },
    ] as VerifiedEntry[];
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("without an evidence reference");
  });

  it("fails when evidence reference names a non-operator tool", () => {
    const report = validReport();
    report.verified = [
      {
        claim: "Canary failed",
        evidence: [
          { tool: "git", artifact: "some-ref", summary: "some summary" },
        ],
      },
    ] as VerifiedEntry[];
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("not an operator evidence tool");
  });

  it("fails when evidence reference has no artifact", () => {
    const report = validReport();
    report.verified = [
      {
        claim: "Canary failed",
        evidence: [
          { tool: "logs.read", artifact: "", summary: "some summary" },
        ],
      },
    ] as VerifiedEntry[];
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("artifact");
  });

  it("fails when report is not an object", () => {
    const result = verifyDiagnosticReport(null);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("not an object");
  });

  it("fails when verified entry has no claim", () => {
    const report = validReport();
    report.verified = [
      { claim: "", evidence: [{ tool: "logs.read", artifact: "ref", summary: "s" }] },
    ] as VerifiedEntry[];
    const result = verifyDiagnosticReport(report);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("claim");
  });
});

describe("diagnostic-report — isOperatorEvidenceTool", () => {
  it("accepts operator tools as evidence sources", () => {
    expect(isOperatorEvidenceTool("logs.describe")).toBe(true);
    expect(isOperatorEvidenceTool("logs.search")).toBe(true);
    expect(isOperatorEvidenceTool("logs.read")).toBe(true);
    expect(isOperatorEvidenceTool("ecs.list_tasks")).toBe(true);
    expect(isOperatorEvidenceTool("ecs.describe_task")).toBe(true);
    expect(isOperatorEvidenceTool("s3.list_task_artifacts")).toBe(true);
    expect(isOperatorEvidenceTool("s3.read_task_metadata")).toBe(true);
    expect(isOperatorEvidenceTool("github.read_issue")).toBe(true);
    expect(isOperatorEvidenceTool("github.read_comments")).toBe(true);
  });

  it("rejects non-operator tools as evidence sources", () => {
    expect(isOperatorEvidenceTool("git")).toBe(false);
    expect(isOperatorEvidenceTool("github-api")).toBe(false);
    expect(isOperatorEvidenceTool("github-merge")).toBe(false);
    expect(isOperatorEvidenceTool("filesystem")).toBe(false);
    expect(isOperatorEvidenceTool("nonexistent")).toBe(false);
  });
});
