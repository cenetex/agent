/**
 * Machine-readable agent role contracts.
 *
 * A role contract is the single source of truth for what an agent role may do.
 * No role behavior depends on a system prompt — the contract is authoritative.
 *
 * Each contract declares:
 *   - role name
 *   - tools available
 *   - permissions required by each tool
 *   - acceptance criteria schema
 *   - verifier name/version
 *   - allowed runtime/task mode
 *   - mutation policy (read-only, branch-write, external-write)
 */
export const ROLE_CONTRACT_VERSION = 1;

/** Mutation policy for a role. */
export type MutationPolicy = "read-only" | "branch-write" | "external-write";

/** Runtime/task mode for a role. */
export type TaskMode = "issue" | "pull_request" | "planning" | "diagnostic";

/** A single tool declaration inside a role contract. */
export interface ToolPermission {
  /** Tool name (e.g. "git", "github-api"). */
  name: string;
  /** Permissions required to use this tool (e.g. ["repo:write", "secrets:none"]). */
  permissions: string[];
}

/** Acceptance criterion schema entry. */
export interface AcceptanceCriterion {
  /** Stable identifier for this criterion (used in task metadata). */
  id: string;
  /** Human-readable description of what is verified. */
  description: string;
  /** JSON-schema-style type for the criterion value. */
  type: "boolean" | "string" | "array";
}

/** A versioned, machine-readable role contract. */
export interface RoleContract {
  /** Contract schema version. */
  version: number;
  /** Role name (developer, reviewer, ...). */
  role: string;
  /** Tools available to this role. */
  tools: ToolPermission[];
  /** Permissions required by each tool (flattened unique set). */
  permissions: string[];
  /** Acceptance criteria schema for tasks under this role. */
  acceptance_criteria: AcceptanceCriterion[];
  /** Verifier identifier and version. */
  verifier: { name: string; version: string };
  /** Allowed runtime/task modes for this role. */
  allowed_modes: TaskMode[];
  /** Mutation policy for this role. */
  mutation_policy: MutationPolicy;
}

/** Valid role names. */
export const ROLE_NAMES = [
  "developer",
  "reviewer",
  "researcher",
  "archivist",
  "operator",
  "trainer",
  "miner",
  "commander",
  "courier",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

// --- Tool declarations (reused across roles) ---

const GIT_TOOLS: ToolPermission[] = [
  { name: "git", permissions: ["repo:read", "repo:write"] },
];

const GITHUB_TOOLS: ToolPermission[] = [
  { name: "github-api", permissions: ["repo:read", "issues:write"] },
];

const READONLY_GITHUB_TOOLS: ToolPermission[] = [
  { name: "github-api", permissions: ["repo:read", "issues:read"] },
];

const FILE_TOOLS_WRITE: ToolPermission[] = [
  { name: "filesystem", permissions: ["fs:write"] },
];

const FILE_TOOLS_READ: ToolPermission[] = [
  { name: "filesystem", permissions: ["fs:read"] },
];

// --- Acceptance criteria templates ---

const CODE_CHANGE_CRITERIA: AcceptanceCriterion[] = [
  { id: "tests_pass", description: "All unit tests pass", type: "boolean" },
  { id: "lint_pass", description: "Linting passes", type: "boolean" },
  { id: "files_changed", description: "List of changed files", type: "array" },
];

const REVIEW_CRITERIA: AcceptanceCriterion[] = [
  { id: "review_comments", description: "Review comments posted", type: "array" },
  { id: "verdict", description: "Approve or request changes", type: "string" },
];

const RESEARCH_CRITERIA: AcceptanceCriterion[] = [
  { id: "summary", description: "Research summary", type: "string" },
  { id: "sources", description: "Sources consulted", type: "array" },
];

const ARCHIVE_CRITERIA: AcceptanceCriterion[] = [
  { id: "artifacts_stored", description: "Artifacts stored", type: "boolean" },
  { id: "index_updated", description: "Archive index updated", type: "boolean" },
];

const DIAGNOSTIC_CRITERIA: AcceptanceCriterion[] = [
  { id: "diagnosis", description: "Diagnostic output", type: "string" },
  { id: "root_cause", description: "Identified root cause", type: "string" },
];

const TRAINING_CRITERIA: AcceptanceCriterion[] = [
  { id: "examples_generated", description: "Training examples generated", type: "array" },
  { id: "quality_score", description: "Quality score", type: "string" },
];

const MINING_CRITERIA: AcceptanceCriterion[] = [
  { id: "data_extracted", description: "Data extracted count", type: "string" },
  { id: "schema_valid", description: "Schema validation passed", type: "boolean" },
];

const COMMAND_CRITERIA: AcceptanceCriterion[] = [
  { id: "commands_executed", description: "Commands executed", type: "array" },
  { id: "exit_status", description: "Exit status", type: "string" },
];

const COURIER_CRITERIA: AcceptanceCriterion[] = [
  { id: "delivered", description: "Payload delivered", type: "boolean" },
  { id: "destination", description: "Delivery destination", type: "string" },
];

// --- Role contract definitions ---

export const ROLE_CONTRACTS: Record<RoleName, RoleContract> = {
  developer: {
    version: ROLE_CONTRACT_VERSION,
    role: "developer",
    tools: [...GIT_TOOLS, ...GITHUB_TOOLS, ...FILE_TOOLS_WRITE],
    permissions: ["repo:read", "repo:write", "issues:write", "fs:write"],
    acceptance_criteria: CODE_CHANGE_CRITERIA,
    verifier: { name: "task-status-verifier", version: "1" },
    allowed_modes: ["issue", "pull_request"],
    mutation_policy: "branch-write",
  },
  reviewer: {
    version: ROLE_CONTRACT_VERSION,
    role: "reviewer",
    tools: [...READONLY_GITHUB_TOOLS, ...FILE_TOOLS_READ],
    permissions: ["repo:read", "issues:read", "issues:write", "fs:read"],
    acceptance_criteria: REVIEW_CRITERIA,
    verifier: { name: "review-verifier", version: "1" },
    allowed_modes: ["pull_request"],
    mutation_policy: "read-only",
  },
  researcher: {
    version: ROLE_CONTRACT_VERSION,
    role: "researcher",
    tools: [...READONLY_GITHUB_TOOLS, ...FILE_TOOLS_READ],
    permissions: ["repo:read", "issues:read", "fs:read"],
    acceptance_criteria: RESEARCH_CRITERIA,
    verifier: { name: "research-verifier", version: "1" },
    allowed_modes: ["planning"],
    mutation_policy: "read-only",
  },
  archivist: {
    version: ROLE_CONTRACT_VERSION,
    role: "archivist",
    tools: [...FILE_TOOLS_WRITE],
    permissions: ["fs:write"],
    acceptance_criteria: ARCHIVE_CRITERIA,
    verifier: { name: "archive-verifier", version: "1" },
    allowed_modes: ["planning"],
    mutation_policy: "branch-write",
  },
  operator: {
    version: ROLE_CONTRACT_VERSION,
    role: "operator",
    tools: [...READONLY_GITHUB_TOOLS],
    permissions: ["repo:read", "issues:read"],
    acceptance_criteria: DIAGNOSTIC_CRITERIA,
    verifier: { name: "diagnostic-verifier", version: "1" },
    allowed_modes: ["diagnostic"],
    mutation_policy: "read-only",
  },
  trainer: {
    version: ROLE_CONTRACT_VERSION,
    role: "trainer",
    tools: [...FILE_TOOLS_WRITE],
    permissions: ["fs:write"],
    acceptance_criteria: TRAINING_CRITERIA,
    verifier: { name: "training-verifier", version: "1" },
    allowed_modes: ["planning"],
    mutation_policy: "branch-write",
  },
  miner: {
    version: ROLE_CONTRACT_VERSION,
    role: "miner",
    tools: [...FILE_TOOLS_READ],
    permissions: ["fs:read"],
    acceptance_criteria: MINING_CRITERIA,
    verifier: { name: "data-verifier", version: "1" },
    allowed_modes: ["planning"],
    mutation_policy: "read-only",
  },
  commander: {
    version: ROLE_CONTRACT_VERSION,
    role: "commander",
    tools: [...GITHUB_TOOLS],
    permissions: ["repo:read", "issues:write"],
    acceptance_criteria: COMMAND_CRITERIA,
    verifier: { name: "command-verifier", version: "1" },
    allowed_modes: ["issue", "planning"],
    mutation_policy: "external-write",
  },
  courier: {
    version: ROLE_CONTRACT_VERSION,
    role: "courier",
    tools: [...FILE_TOOLS_READ],
    permissions: ["fs:read"],
    acceptance_criteria: COURIER_CRITERIA,
    verifier: { name: "delivery-verifier", version: "1" },
    allowed_modes: ["issue", "planning"],
    mutation_policy: "read-only",
  },
};

/** Type guard for a valid role name string. */
export function isValidRoleName(role: string): role is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(role);
}

/**
 * Validate a role contract structurally.
 * Throws a descriptive Error if the contract is invalid.
 * Invalid role definitions must fail validation before dispatch.
 */
export function validateRoleContract(contract: RoleContract): void {
  if (!contract || typeof contract !== "object") {
    throw new Error("Role contract is not an object");
  }
  if (contract.version !== ROLE_CONTRACT_VERSION) {
    throw new Error(
      `Role contract version mismatch: expected ${ROLE_CONTRACT_VERSION}, got ${contract.version}`
    );
  }
  if (!contract.role || typeof contract.role !== "string") {
    throw new Error("Role contract is missing a role name");
  }
  if (!isValidRoleName(contract.role)) {
    throw new Error(`Unknown role name: ${contract.role}`);
  }
  if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
    throw new Error(`Role ${contract.role} must declare at least one tool`);
  }
  for (const tool of contract.tools) {
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error(`Role ${contract.role} has a tool with no name`);
    }
    if (!Array.isArray(tool.permissions)) {
      throw new Error(`Role ${contract.role} tool ${tool.name} has no permissions array`);
    }
  }
  if (!Array.isArray(contract.permissions) || contract.permissions.length === 0) {
    throw new Error(`Role ${contract.role} must declare at least one permission`);
  }
  if (!Array.isArray(contract.acceptance_criteria) || contract.acceptance_criteria.length === 0) {
    throw new Error(`Role ${contract.role} must declare at least one acceptance criterion`);
  }
  for (const criterion of contract.acceptance_criteria) {
    if (!criterion.id || typeof criterion.id !== "string") {
      throw new Error(`Role ${contract.role} has an acceptance criterion with no id`);
    }
    if (!["boolean", "string", "array"].includes(criterion.type)) {
      throw new Error(`Role ${contract.role} criterion ${criterion.id} has invalid type`);
    }
  }
  if (!contract.verifier || !contract.verifier.name || !contract.verifier.version) {
    throw new Error(`Role ${contract.role} is missing a verifier name/version`);
  }
  if (!Array.isArray(contract.allowed_modes) || contract.allowed_modes.length === 0) {
    throw new Error(`Role ${contract.role} must declare at least one allowed mode`);
  }
  for (const mode of contract.allowed_modes) {
    if (!["issue", "pull_request", "planning", "diagnostic"].includes(mode)) {
      throw new Error(`Role ${contract.role} has invalid allowed mode: ${mode}`);
    }
  }
  if (!["read-only", "branch-write", "external-write"].includes(contract.mutation_policy)) {
    throw new Error(`Role ${contract.role} has invalid mutation policy: ${contract.mutation_policy}`);
  }
}

/**
 * Resolved role contract attached to a dispatched task.
 * Carries the resolved role, tool names, permission set, verifier, and
 * acceptance criteria IDs so the verifier can inspect serialized metadata.
 */
export interface ResolvedRole {
  /** Contract version. */
  version: number;
  /** Role name. */
  role: string;
  /** Tool names available to this role. */
  tools: string[];
  /** Flattened, deduplicated permission set. */
  permissions: string[];
  /** Verifier name and version. */
  verifier: { name: string; version: string };
  /** Acceptance criteria IDs for this task. */
  acceptance_criteria_ids: string[];
  /** Mutation policy. */
  mutation_policy: MutationPolicy;
  /** Allowed task modes. */
  allowed_modes: TaskMode[];
}

/**
 * Resolve and validate a role contract by role name.
 * Throws if the role is unknown or the contract fails validation.
 */
export function resolveRoleContract(roleName: string): ResolvedRole {
  if (!isValidRoleName(roleName)) {
    throw new Error(`Unknown role: ${roleName}`);
  }
  const contract = ROLE_CONTRACTS[roleName];
  validateRoleContract(contract);
  return {
    version: contract.version,
    role: contract.role,
    tools: contract.tools.map((t) => t.name),
    permissions: dedupe(contract.permissions),
    verifier: { ...contract.verifier },
    acceptance_criteria_ids: contract.acceptance_criteria.map((c) => c.id),
    mutation_policy: contract.mutation_policy,
    allowed_modes: [...contract.allowed_modes],
  };
}

/**
 * Validate that a task mode is allowed by the resolved role.
 * Throws if the mode is not in the role's allowed_modes list.
 */
export function assertModeAllowed(roleName: string, taskMode: TaskMode): void {
  const resolved = resolveRoleContract(roleName);
  if (!resolved.allowed_modes.includes(taskMode)) {
    throw new Error(
      `Role ${roleName} does not allow task mode ${taskMode} (allowed: ${resolved.allowed_modes.join(", ")})`
    );
  }
}

/** Deduplicate an array of strings, preserving order. */
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/**
 * Validate all built-in role contracts at import time.
 * If any contract is invalid, this throws immediately so the module
 * cannot be used to dispatch with a broken role definition.
 */
function validateAllContracts(): void {
  for (const roleName of ROLE_NAMES) {
    validateRoleContract(ROLE_CONTRACTS[roleName]);
  }
}

// Eagerly validate built-in contracts so a broken definition fails fast.
validateAllContracts();
