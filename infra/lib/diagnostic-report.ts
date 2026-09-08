/**
 * Diagnostic evidence report schema and verifier for the operator role.
 *
 * The operator agent produces an evidence report with five required sections:
 *   - Observed:    what was directly observed from live system inspection
 *   - Verified:    claims backed by an explicit evidence reference
 *   - Suspected:   hypotheses not yet confirmed by evidence
 *   - Unknown:     areas where data was unavailable or inconclusive
 *   - Recommended:  the next action the operator recommends
 *
 * The verifier fails the task if:
 *   - Any required section is missing or empty.
 *   - The Verified section claims verification without an evidence reference.
 */
import type { ResolvedRole } from "./role-contracts";

/** The five required sections of an operator evidence report. */
export const REPORT_SECTIONS = [
  "observed",
  "verified",
  "suspected",
  "unknown",
  "recommended",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** A single evidence reference tying a verified claim to a tool artifact. */
export interface EvidenceReference {
  /** Tool that produced the evidence (must be an operator tool). */
  tool: string;
  /** Artifact or log reference produced by the tool call. */
  artifact: string;
  /** Human-readable summary of what the evidence shows. */
  summary: string;
}

/** An entry in the Verified section must carry at least one evidence reference. */
export interface VerifiedEntry {
  /** The claim being verified. */
  claim: string;
  /** Evidence references backing the claim (at least one required). */
  evidence: EvidenceReference[];
}

/** The full diagnostic evidence report. */
export interface DiagnosticReport {
  /** Task ID this report belongs to. */
  task_id: string;
  /** Sections of the report. */
  observed: string;
  verified: VerifiedEntry[];
  suspected: string;
  unknown: string;
  recommended: string;
}

/** Result of verifying a diagnostic report. */
export interface DiagnosticVerificationResult {
  /** Whether the report passes verification. */
  passed: boolean;
  /** List of failure reasons (empty if passed). */
  failures: string[];
}

/** The set of tools the operator role is allowed to reference as evidence. */
const OPERATOR_EVIDENCE_TOOLS = new Set([
  "logs.describe",
  "logs.search",
  "logs.read",
  "ecs.list_tasks",
  "ecs.describe_task",
  "s3.list_task_artifacts",
  "s3.read_task_metadata",
  "github.read_issue",
  "github.read_comments",
]);

/**
 * Verify a diagnostic evidence report against the operator acceptance criteria.
 *
 * Fails if:
 *   - Any required section is missing, null, or empty.
 *   - The Verified section has no entries.
 *   - A Verified entry has no evidence references.
 *   - An evidence reference names a tool not in the operator tool set.
 *
 * @param report The report to verify.
 * @param resolvedRole The resolved operator role (used for context).
 */
export function verifyDiagnosticReport(
  report: unknown,
  resolvedRole?: ResolvedRole
): DiagnosticVerificationResult {
  const failures: string[] = [];

  if (!report || typeof report !== "object") {
    return { passed: false, failures: ["Report is not an object"] };
  }

  const r = report as Partial<DiagnosticReport>;

  // --- Required text sections must be non-empty strings ---
  for (const section of ["observed", "suspected", "unknown", "recommended"] as const) {
    const value = r[section];
    if (typeof value !== "string" || value.trim().length === 0) {
      failures.push(`Missing or empty required section: "${section}"`);
    }
  }

  // --- Verified section must be a non-empty array of entries with evidence ---
  if (!Array.isArray(r.verified) || r.verified.length === 0) {
    failures.push('Missing or empty required section: "verified" (must be a non-empty array)');
  } else {
    for (let i = 0; i < r.verified.length; i++) {
      const entry = r.verified[i] as Partial<VerifiedEntry> | undefined;
      if (!entry || typeof entry.claim !== "string" || entry.claim.trim().length === 0) {
        failures.push(`Verified entry ${i}: missing or empty "claim"`);
      }
      if (!Array.isArray(entry?.evidence) || entry!.evidence.length === 0) {
        failures.push(`Verified entry ${i}: claims verification without an evidence reference`);
      } else {
        for (let j = 0; j < entry!.evidence.length; j++) {
          const ref = entry!.evidence[j] as Partial<EvidenceReference> | undefined;
          if (!ref || typeof ref.tool !== "string" || ref.tool.trim().length === 0) {
            failures.push(`Verified entry ${i} evidence ${j}: missing "tool"`);
          } else if (!OPERATOR_EVIDENCE_TOOLS.has(ref.tool)) {
            failures.push(`Verified entry ${i} evidence ${j}: tool "${ref.tool}" is not an operator evidence tool`);
          }
          if (!ref || typeof ref.artifact !== "string" || ref.artifact.trim().length === 0) {
            failures.push(`Verified entry ${i} evidence ${j}: missing "artifact" reference`);
          }
          if (!ref || typeof ref.summary !== "string" || ref.summary.trim().length === 0) {
            failures.push(`Verified entry ${i} evidence ${j}: missing "summary"`);
          }
        }
      }
    }
  }

  // --- task_id consistency (if resolvedRole is provided) ---
  if (resolvedRole && r.task_id !== undefined && typeof r.task_id === "string" && r.task_id.trim().length === 0) {
    failures.push('Missing or empty "task_id"');
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Check whether a tool name is a valid operator evidence tool.
 */
export function isOperatorEvidenceTool(toolName: string): boolean {
  return OPERATOR_EVIDENCE_TOOLS.has(toolName);
}
