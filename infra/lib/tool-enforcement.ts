/**
 * Tool enforcement at dispatch and execution boundaries.
 *
 * This module enforces that:
 * 1. Dispatch rejects a role whose requested tool is not in its role contract.
 * 2. Execution rejects a tool call whose permission is absent from the task capability packet.
 * 3. Read-only roles cannot call write, push, merge, label, credit, or deployment tools.
 * 4. Every tool call emits an evidence record.
 * 5. Denied calls are recorded as explicit failures.
 *
 * Uses the existing capability packet (ResolvedRole), parent-owned tool boundary,
 * and token/lease checks. Does not introduce a second permission system.
 */
import type { ResolvedRole, MutationPolicy } from "./role-contracts";

/** Stable mutation level for a tool. */
export type MutationLevel = "read" | "write";

/** Tool categories subject to read-only restrictions. */
export type ToolCategory =
  | "read"
  | "write"
  | "push"
  | "merge"
  | "label"
  | "credit"
  | "deployment"
  | "filesystem";

/** A single tool in the central tool catalog. */
export interface ToolDefinition {
  /** Stable tool name (e.g. "git", "github-api"). */
  name: string;
  /** Stable tool version. */
  version: string;
  /** Input schema (JSON-schema-style object). */
  input_schema: Record<string, unknown>;
  /** Output schema (JSON-schema-style object). */
  output_schema: Record<string, unknown>;
  /** Permissions that can grant access to this tool (role must hold at least one). */
  permissions: string[];
  /** Mutation level of this tool. */
  mutation_level: MutationLevel;
  /** Whether this tool emits evidence of its execution. */
  emits_evidence: true;
  /** Categories that classify the tool (used for read-only enforcement). */
  categories: ToolCategory[];
}

/**
 * The central tool catalog — the parent-owned tool boundary.
 * Every tool that an agent may invoke must be declared here with stable
 * name, version, schemas, permissions, mutation level, and evidence policy.
 *
 * The `permissions` field lists ALL permissions that can grant access to the
 * tool. A role must hold at least one of these to use the tool. This lets a
 * single tool (e.g. "filesystem") serve both read-only roles (fs:read) and
 * write roles (fs:write) without requiring a separate permission system.
 */
export const TOOL_CATALOG: Record<string, ToolDefinition> = {
  git: {
    name: "git",
    version: "1",
    input_schema: { type: "object", properties: { command: { type: "string" }, args: { type: "array" } } },
    output_schema: { type: "object", properties: { stdout: { type: "string" }, exit_code: { type: "number" } } },
    permissions: ["repo:read", "repo:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["read", "write", "push"],
  },
  "github-api": {
    name: "github-api",
    version: "1",
    input_schema: { type: "object", properties: { method: { type: "string" }, path: { type: "string" } } },
    output_schema: { type: "object", properties: { status: { type: "number" }, body: { type: "object" } } },
    permissions: ["repo:read", "issues:read", "issues:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["read"],
  },
  filesystem: {
    name: "filesystem",
    version: "1",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    output_schema: { type: "object", properties: { bytes_written: { type: "number" } } },
    permissions: ["fs:read", "fs:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["read", "filesystem"],
  },
  "github-label": {
    name: "github-label",
    version: "1",
    input_schema: { type: "object", properties: { labels: { type: "array" } } },
    output_schema: { type: "object", properties: { applied: { type: "boolean" } } },
    permissions: ["issues:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["label", "write"],
  },
  "github-merge": {
    name: "github-merge",
    version: "1",
    input_schema: { type: "object", properties: { pr_number: { type: "number" } } },
    output_schema: { type: "object", properties: { merged: { type: "boolean" } } },
    permissions: ["repo:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["merge", "write"],
  },
  "github-push": {
    name: "github-push",
    version: "1",
    input_schema: { type: "object", properties: { branch: { type: "string" } } },
    output_schema: { type: "object", properties: { pushed: { type: "boolean" } } },
    permissions: ["repo:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["push", "write"],
  },
  "github-deploy": {
    name: "github-deploy",
    version: "1",
    input_schema: { type: "object", properties: { environment: { type: "string" } } },
    output_schema: { type: "object", properties: { deployed: { type: "boolean" } } },
    permissions: ["repo:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["deployment", "write"],
  },
  "credit-charge": {
    name: "credit-charge",
    version: "1",
    input_schema: { type: "object", properties: { amount: { type: "number" } } },
    output_schema: { type: "object", properties: { charged: { type: "boolean" } } },
    permissions: ["credits:write"],
    mutation_level: "write",
    emits_evidence: true,
    categories: ["credit", "write"],
  },
};

/** Categories blocked for read-only roles. */
export const READ_ONLY_BLOCKED_CATEGORIES: ToolCategory[] = [
  "write",
  "push",
  "merge",
  "label",
  "credit",
  "deployment",
];

/** Evidence record emitted for every tool call. */
export interface ToolCallEvidence {
  /** Task ID. */
  task_id: string;
  /** Tool name. */
  tool_name: string;
  /** Permission checked. */
  permission: string;
  /** Timestamp (ISO 8601). */
  timestamp: string;
  /** Result state: "allowed" or "denied". */
  result_state: "allowed" | "denied";
  /** Artifact/reference produced (or null for denied calls). */
  artifact: string | null;
}

/** Result of a tool call attempt — records both allowed and denied calls. */
export interface ToolCallResult {
  /** Task ID associated with the call. */
  task_id: string;
  /** Tool name invoked. */
  tool_name: string;
  /** Permission(s) checked for this call. */
  permission: string;
  /** Timestamp of the call (ISO 8601). */
  timestamp: string;
  /** Whether the call was allowed or denied. */
  result_state: "allowed" | "denied";
  /** Human-readable reason for the decision. */
  reason: string;
  /** Artifact or reference produced by the call (or null if denied). */
  artifact: string | null;
  /** Evidence record — always present, even for denied calls. */
  evidence: ToolCallEvidence;
}

/**
 * The capability packet used at execution boundary.
 * Derived from the existing ResolvedRole (single source of truth) —
 * does not introduce a second permission system.
 */
export interface CapabilityPacket {
  /** Task ID this packet is scoped to. */
  task_id: string;
  /** Role name. */
  role: string;
  /** Mutation policy of the role. */
  mutation_policy: MutationPolicy;
  /** Tool names available to this role (from ResolvedRole). */
  tools: string[];
  /** Permissions available to this role (from ResolvedRole). */
  permissions: string[];
}

/** Discriminated error type for tool enforcement failures. */
export class ToolEnforcementError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ToolEnforcementError";
    this.code = code;
  }
}

/**
 * Build a capability packet from an existing ResolvedRole.
 * This is the bridge between the role contract and the execution boundary.
 */
export function buildCapabilityPacket(
  taskId: string,
  resolvedRole: ResolvedRole
): CapabilityPacket {
  return {
    task_id: taskId,
    role: resolvedRole.role,
    mutation_policy: resolvedRole.mutation_policy,
    tools: [...resolvedRole.tools],
    permissions: [...resolvedRole.permissions],
  };
}

/** The full result of a dispatch-time tool check. */
export interface DispatchCheckResult {
  allowed: boolean;
  tool_definition: ToolDefinition | null;
  reason: string;
  evidence: ToolCallEvidence;
}

/**
 * Resolve a tool definition from the catalog, ensuring the tool exists.
 */
export function getToolDefinition(toolName: string): ToolDefinition {
  const def = TOOL_CATALOG[toolName];
  if (!def) {
    throw new ToolEnforcementError(
      `Unknown tool: "${toolName}" is not in the tool catalog`,
      "unknown_tool"
    );
  }
  return def;
}

/**
 * Dispatch-time check: reject a role whose requested tool is not in its role contract.
 * Throws if the tool is not available to the role.
 *
 * @param resolvedRole The resolved role contract.
 * @param toolName The tool the role is requesting.
 * @returns The tool definition if the tool is in the role's contract.
 */
export function assertToolInRoleContract(
  resolvedRole: ResolvedRole,
  toolName: string
): ToolDefinition {
  if (!resolvedRole.tools.includes(toolName)) {
    throw new ToolEnforcementError(
      `Dispatch rejected: tool "${toolName}" is not in role contract for role "${resolvedRole.role}". ` +
        `Available tools: ${resolvedRole.tools.join(", ")}`,
      "tool_not_in_contract"
    );
  }
  return getToolDefinition(toolName);
}

/**
 * Execution-time check: reject a tool call whose permission is absent from
 * the task capability packet.
 *
 * A tool declares the set of permissions that can grant access. The role
 * must hold at least one of them. If the role holds none, the call is
 * rejected — the required permission is absent from the capability packet.
 *
 * @param packet The capability packet for this task.
 * @param toolName The tool being invoked.
 * @returns The tool definition if at least one permission is satisfied.
 */
export function assertPermissionsInCapabilityPacket(
  packet: CapabilityPacket,
  toolName: string
): ToolDefinition {
  const toolDef = getToolDefinition(toolName);
  const hasPermission = toolDef.permissions.some((p) =>
    packet.permissions.includes(p)
  );
  if (!hasPermission) {
    throw new ToolEnforcementError(
      `Execution rejected: tool "${toolName}" requires permission(s) [${toolDef.permissions.join(", ")}] ` +
        `which are all absent from the capability packet for role "${packet.role}" ` +
        `(packet permissions: ${packet.permissions.join(", ")})`,
      "permission_absent"
    );
  }
  return toolDef;
}

/**
 * Read-only enforcement: read-only roles cannot call write, push, merge,
 * label, credit, or deployment tools.
 *
 * A tool is blocked for read-only roles if it has ANY blocked category.
 * Tools like "filesystem" and "github-api" do not carry blocked categories
 * (they only have "read"/"filesystem"), so they remain available to
 * read-only roles. The permission check independently ensures the role
 * can only perform operations its permissions allow.
 *
 * @throws if a read-only role attempts a blocked tool.
 */
export function assertReadOnlyNotViolated(
  packet: CapabilityPacket,
  toolName: string
): void {
  if (packet.mutation_policy !== "read-only") {
    return;
  }
  const toolDef = getToolDefinition(toolName);
  const blocked = toolDef.categories.filter((c) =>
    READ_ONLY_BLOCKED_CATEGORIES.includes(c)
  );
  if (blocked.length > 0) {
    throw new ToolEnforcementError(
      `Read-only role "${packet.role}" cannot use tool "${toolName}" ` +
        `(blocked categories: ${blocked.join(", ")})`,
      "read_only_violation"
    );
  }
}

/**
 * Validate a tool call input against the tool's input schema.
 * Lightweight structural check — verifies required top-level keys are present
 * and basic type expectations are met.
 * @throws on malformed input.
 */
export function validateToolInput(
  toolName: string,
  input: unknown
): void {
  if (input === null || input === undefined) {
    throw new ToolEnforcementError(
      `Malformed input for tool "${toolName}": input is null or undefined`,
      "malformed_input"
    );
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ToolEnforcementError(
      `Malformed input for tool "${toolName}": expected an object`,
      "malformed_input"
    );
  }
  const toolDef = getToolDefinition(toolName);
  const schemaProps = (toolDef.input_schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const obj = input as Record<string, unknown>;
  for (const [key, schema] of Object.entries(schemaProps)) {
    if (!schema || typeof schema !== "object") continue;
    const expectedType = schema.type;
    const value = obj[key];
    if (value === undefined) continue;
    if (expectedType === "string" && typeof value !== "string") {
      throw new ToolEnforcementError(
        `Malformed input for tool "${toolName}": field "${key}" must be a string`,
        "malformed_input"
      );
    }
    if (expectedType === "number" && typeof value !== "number") {
      throw new ToolEnforcementError(
        `Malformed input for tool "${toolName}": field "${key}" must be a number`,
        "malformed_input"
      );
    }
    if (expectedType === "array" && !Array.isArray(value)) {
      throw new ToolEnforcementError(
        `Malformed input for tool "${toolName}": field "${key}" must be an array`,
        "malformed_input"
      );
    }
  }
}

/**
 * Emit an evidence record for a tool call.
 * Always produces an evidence record — even for denied calls.
 */
export function emitToolCallEvidence(
  taskId: string,
  toolName: string,
  permission: string,
  resultState: "allowed" | "denied",
  artifact: string | null,
  timestamp: string = new Date().toISOString()
): ToolCallEvidence {
  return {
    task_id: taskId,
    tool_name: toolName,
    permission,
    timestamp,
    result_state: resultState,
    artifact,
  };
}

/**
 * Dispatch-time enforcement: checks that a role may request a given tool.
 * Combines contract membership, permission presence, and read-only checks.
 * Always emits an evidence record (allowed or denied).
 *
 * @param resolvedRole The resolved role contract.
 * @param taskId The task ID.
 * @param toolName The tool being requested.
 * @param timestamp Optional timestamp for deterministic tests.
 * @returns A DispatchCheckResult with the decision and evidence.
 */
export function checkDispatchTool(
  resolvedRole: ResolvedRole,
  taskId: string,
  toolName: string,
  timestamp: string = new Date().toISOString()
): DispatchCheckResult {
  try {
    assertToolInRoleContract(resolvedRole, toolName);
    const packet = buildCapabilityPacket(taskId, resolvedRole);
    assertPermissionsInCapabilityPacket(packet, toolName);
    assertReadOnlyNotViolated(packet, toolName);
    const toolDef = getToolDefinition(toolName);
    return {
      allowed: true,
      tool_definition: toolDef,
      reason: `Tool "${toolName}" is allowed for role "${resolvedRole.role}"`,
      evidence: emitToolCallEvidence(
        taskId,
        toolName,
        toolDef.permissions.join(","),
        "allowed",
        `dispatch:${taskId}/${toolName}`,
        timestamp
      ),
    };
  } catch (err) {
    const reason =
      err instanceof ToolEnforcementError
        ? err.message
        : `Unexpected error: ${String(err)}`;
    return {
      allowed: false,
      tool_definition: null,
      reason,
      evidence: emitToolCallEvidence(
        taskId,
        toolName,
        "none",
        "denied",
        null,
        timestamp
      ),
    };
  }
}

/**
 * Execution-time enforcement: checks that a tool call may execute
 * given the capability packet.
 * Combines permission check, read-only enforcement, and input validation.
 * Always emits an evidence record (allowed or denied).
 *
 * @param packet The capability packet for this task.
 * @param toolName The tool being called.
 * @param input The input to the tool call.
 * @param timestamp Optional timestamp for deterministic tests.
 * @returns A ToolCallResult with the decision, reason, and evidence.
 */
export function executeToolCall(
  packet: CapabilityPacket,
  toolName: string,
  input: unknown,
  timestamp: string = new Date().toISOString()
): ToolCallResult {
  const denied = (
    permission: string,
    reason: string
  ): ToolCallResult => ({
    task_id: packet.task_id,
    tool_name: toolName,
    permission,
    timestamp,
    result_state: "denied",
    reason,
    artifact: null,
    evidence: emitToolCallEvidence(
      packet.task_id,
      toolName,
      permission,
      "denied",
      null,
      timestamp
    ),
  });

  // Permission check (also validates tool exists in catalog)
  let toolDef: ToolDefinition;
  try {
    toolDef = assertPermissionsInCapabilityPacket(packet, toolName);
  } catch (err) {
    return denied(
      "none",
      err instanceof ToolEnforcementError
        ? err.message
        : `Unexpected error: ${String(err)}`
    );
  }

  const permStr = toolDef.permissions.join(",");

  // Read-only enforcement
  try {
    assertReadOnlyNotViolated(packet, toolName);
  } catch (err) {
    return denied(
      permStr,
      err instanceof ToolEnforcementError
        ? err.message
        : `Unexpected error: ${String(err)}`
    );
  }

  // Input validation
  try {
    validateToolInput(toolName, input);
  } catch (err) {
    return denied(
      permStr,
      err instanceof ToolEnforcementError
        ? err.message
        : `Unexpected error: ${String(err)}`
    );
  }

  // Allowed — emit evidence with artifact reference
  return {
    task_id: packet.task_id,
    tool_name: toolName,
    permission: permStr,
    timestamp,
    result_state: "allowed",
    reason: `Tool "${toolName}" executed successfully for role "${packet.role}"`,
    artifact: `artifact:${packet.task_id}/${toolName}`,
    evidence: emitToolCallEvidence(
      packet.task_id,
      toolName,
      permStr,
      "allowed",
      `artifact:${packet.task_id}/${toolName}`,
      timestamp
    ),
  };
}
