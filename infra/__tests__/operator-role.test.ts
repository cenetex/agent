import {
  resolveRoleContract,
  ROLE_CONTRACTS,
} from "../lib/role-contracts";
import {
  TOOL_CATALOG,
  buildCapabilityPacket,
  checkDispatchTool,
  executeToolCall,
  READ_ONLY_BLOCKED_CATEGORIES,
} from "../lib/tool-enforcement";

const TS = "2026-09-07T00:00:00.000Z";

const OPERATOR_TOOLS = [
  "logs.describe",
  "logs.search",
  "logs.read",
  "ecs.list_tasks",
  "ecs.describe_task",
  "s3.list_task_artifacts",
  "s3.read_task_metadata",
  "github.read_issue",
  "github.read_comments",
] as const;

describe("operator role contract", () => {
  it("resolves the operator role as read-only", () => {
    const resolved = resolveRoleContract("operator");
    expect(resolved.role).toBe("operator");
    expect(resolved.mutation_policy).toBe("read-only");
    expect(resolved.allowed_modes).toEqual(["diagnostic"]);
  });

  it("exposes only the operator inspection tools", () => {
    const resolved = resolveRoleContract("operator");
    expect(resolved.tools.sort()).toEqual([...OPERATOR_TOOLS].sort());
    // Must NOT include any mutation tools
    expect(resolved.tools).not.toContain("git");
    expect(resolved.tools).not.toContain("github-label");
    expect(resolved.tools).not.toContain("github-merge");
    expect(resolved.tools).not.toContain("github-push");
    expect(resolved.tools).not.toContain("github-deploy");
    expect(resolved.tools).not.toContain("credit-charge");
  });

  it("grants only read-only permissions", () => {
    const resolved = resolveRoleContract("operator");
    expect(resolved.permissions).toContain("logs:read");
    expect(resolved.permissions).toContain("ecs:read");
    expect(resolved.permissions).toContain("s3:read");
    expect(resolved.permissions).toContain("repo:read");
    expect(resolved.permissions).toContain("issues:read");
    // No write permissions
    expect(resolved.permissions).not.toContain("repo:write");
    expect(resolved.permissions).not.toContain("issues:write");
    expect(resolved.permissions).not.toContain("fs:write");
    expect(resolved.permissions).not.toContain("deploy:write");
    expect(resolved.permissions).not.toContain("credits:write");
  });

  it("uses the diagnostic-verifier v2", () => {
    const resolved = resolveRoleContract("operator");
    expect(resolved.verifier).toEqual({ name: "diagnostic-verifier", version: "2" });
  });

  it("acceptance criteria cover all five report sections", () => {
    const contract = ROLE_CONTRACTS.operator;
    const ids = contract.acceptance_criteria.map((c) => c.id);
    expect(ids).toContain("report_observed");
    expect(ids).toContain("report_verified");
    expect(ids).toContain("report_suspected");
    expect(ids).toContain("report_unknown");
    expect(ids).toContain("report_recommended");
  });
});

describe("operator tool catalog", () => {
  it("every operator tool is defined in the tool catalog", () => {
    for (const toolName of OPERATOR_TOOLS) {
      expect(TOOL_CATALOG[toolName]).toBeDefined();
    }
  });

  it("every operator tool is read-level with read-only categories", () => {
    for (const toolName of OPERATOR_TOOLS) {
      const def = TOOL_CATALOG[toolName];
      expect(def.mutation_level).toBe("read");
      expect(def.categories).toEqual(["read"]);
      // No blocked categories
      const blocked = def.categories.filter((c) =>
        READ_ONLY_BLOCKED_CATEGORIES.includes(c)
      );
      expect(blocked).toEqual([]);
    }
  });

  it("every operator tool emits evidence", () => {
    for (const toolName of OPERATOR_TOOLS) {
      expect(TOOL_CATALOG[toolName].emits_evidence).toBe(true);
    }
  });
});

describe("operator dispatch and execution enforcement", () => {
  it("allows dispatch of all operator tools", () => {
    const resolved = resolveRoleContract("operator");
    for (const toolName of OPERATOR_TOOLS) {
      const result = checkDispatchTool(resolved, "task_op", toolName, TS);
      expect(result.allowed).toBe(true);
      expect(result.evidence.result_state).toBe("allowed");
    }
  });

  it("denies dispatch of mutation tools not in operator contract", () => {
    const resolved = resolveRoleContract("operator");
    for (const toolName of ["git", "github-merge", "github-push", "github-label", "github-deploy", "credit-charge"]) {
      const result = checkDispatchTool(resolved, "task_op", toolName, TS);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in role contract");
    }
  });

  it("allows execution of operator tools via capability packet", () => {
    const packet = buildCapabilityPacket("task_op", resolveRoleContract("operator"));
    const result = executeToolCall(
      packet,
      "logs.search",
      { log_group_name: "/aws/lambda/test", filter_pattern: "ERROR" },
      TS
    );
    expect(result.result_state).toBe("allowed");
    expect(result.evidence.result_state).toBe("allowed");
  });

  it("denies execution of mutation tools for read-only operator", () => {
    const packet = buildCapabilityPacket("task_op", resolveRoleContract("operator"));
    const result = executeToolCall(packet, "github-merge", { pr_number: 1 }, TS);
    expect(result.result_state).toBe("denied");
  });
});
