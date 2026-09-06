import {
  TOOL_CATALOG,
  READ_ONLY_BLOCKED_CATEGORIES,
  buildCapabilityPacket,
  assertToolInRoleContract,
  assertPermissionsInCapabilityPacket,
  assertReadOnlyNotViolated,
  validateToolInput,
  emitToolCallEvidence,
  checkDispatchTool,
  executeToolCall,
  getToolDefinition,
  ToolEnforcementError,
  type CapabilityPacket,
} from '../lib/tool-enforcement';
import { resolveRoleContract } from '../lib/role-contracts';

const TS = '2026-09-06T22:00:00.000Z';

function devPacket(taskId = 'task_test'): CapabilityPacket {
  return buildCapabilityPacket(taskId, resolveRoleContract('developer'));
}

function reviewerPacket(taskId = 'task_test'): CapabilityPacket {
  return buildCapabilityPacket(taskId, resolveRoleContract('reviewer'));
}

describe('tool-enforcement — tool catalog', () => {
  it('every tool has stable name, version, schemas, permissions, mutation level, evidence, and categories', () => {
    for (const [key, tool] of Object.entries(TOOL_CATALOG)) {
      expect(tool.name).toBe(key);
      expect(typeof tool.version).toBe('string');
      expect(tool.version.length).toBeGreaterThan(0);
      expect(tool.input_schema).toBeDefined();
      expect(tool.output_schema).toBeDefined();
      expect(Array.isArray(tool.permissions)).toBe(true);
      expect(tool.permissions.length).toBeGreaterThan(0);
      expect(['read', 'write']).toContain(tool.mutation_level);
      expect(tool.emits_evidence).toBe(true);
      expect(Array.isArray(tool.categories)).toBe(true);
    }
  });

  it('defines all expected tools', () => {
    const expected = [
      'git',
      'github-api',
      'filesystem',
      'github-label',
      'github-merge',
      'github-push',
      'github-deploy',
      'credit-charge',
    ];
    for (const name of expected) {
      expect(TOOL_CATALOG[name]).toBeDefined();
    }
  });

  it('read-only blocked categories include write, push, merge, label, credit, deployment', () => {
    expect(READ_ONLY_BLOCKED_CATEGORIES).toEqual(
      expect.arrayContaining(['write', 'push', 'merge', 'label', 'credit', 'deployment'])
    );
  });
});

describe('tool-enforcement — capability packet', () => {
  it('builds a packet from a resolved role', () => {
    const resolved = resolveRoleContract('developer');
    const packet = buildCapabilityPacket('task_1', resolved);
    expect(packet.task_id).toBe('task_1');
    expect(packet.role).toBe('developer');
    expect(packet.mutation_policy).toBe('branch-write');
    expect(packet.tools).toContain('git');
    expect(packet.permissions).toContain('repo:write');
  });

  it('packet is a snapshot, not a reference to the resolved role', () => {
    const resolved = resolveRoleContract('developer');
    const packet = buildCapabilityPacket('task_1', resolved);
    packet.tools.push('malicious-tool');
    expect(resolved.tools).not.toContain('malicious-tool');
  });
});

describe('tool-enforcement — dispatch boundary', () => {
  it('allows a tool that is in the role contract', () => {
    const resolved = resolveRoleContract('developer');
    const result = checkDispatchTool(resolved, 'task_1', 'git', TS);
    expect(result.allowed).toBe(true);
    expect(result.tool_definition).not.toBeNull();
    expect(result.tool_definition!.name).toBe('git');
    expect(result.evidence.result_state).toBe('allowed');
  });

  it('rejects a tool not in the role contract', () => {
    const resolved = resolveRoleContract('reviewer');
    const result = checkDispatchTool(resolved, 'task_1', 'git', TS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in role contract');
    expect(result.evidence.result_state).toBe('denied');
    expect(result.evidence.artifact).toBeNull();
  });

  it('rejects an unknown tool', () => {
    const resolved = resolveRoleContract('developer');
    const result = checkDispatchTool(resolved, 'task_1', 'nonexistent-tool', TS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in role contract');
  });

  it('always emits an evidence record with task_id, tool_name, permission, timestamp, result_state, and artifact', () => {
    const resolved = resolveRoleContract('developer');
    const allowed = checkDispatchTool(resolved, 'task_1', 'git', TS);
    expect(allowed.evidence.task_id).toBe('task_1');
    expect(allowed.evidence.tool_name).toBe('git');
    expect(allowed.evidence.permission).toBeTruthy();
    expect(allowed.evidence.timestamp).toBe(TS);
    expect(allowed.evidence.result_state).toBe('allowed');
    expect(allowed.evidence.artifact).not.toBeNull();

    const denied = checkDispatchTool(resolved, 'task_1', 'github-merge', TS);
    expect(denied.evidence.task_id).toBe('task_1');
    expect(denied.evidence.tool_name).toBe('github-merge');
    expect(denied.evidence.permission).toBe('none');
    expect(denied.evidence.timestamp).toBe(TS);
    expect(denied.evidence.result_state).toBe('denied');
    expect(denied.evidence.artifact).toBeNull();
  });

  it('developer role can use git, github-api, filesystem', () => {
    const resolved = resolveRoleContract('developer');
    for (const tool of ['git', 'github-api', 'filesystem']) {
      expect(checkDispatchTool(resolved, 'task_1', tool, TS).allowed).toBe(true);
    }
  });
});

describe('tool-enforcement — execution boundary', () => {
  it('allows a tool call when permission is present in the capability packet', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', { command: 'status' }, TS);
    expect(result.result_state).toBe('allowed');
    expect(result.permission).toContain('repo:read');
    expect(result.artifact).not.toBeNull();
    expect(result.evidence.result_state).toBe('allowed');
    expect(result.evidence.artifact).not.toBeNull();
  });

  it('rejects a tool call when permission is absent from the capability packet', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-merge', { pr_number: 42 }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('permission');
    expect(result.artifact).toBeNull();
    expect(result.evidence.result_state).toBe('denied');
  });

  it('rejects a tool call for an unknown tool', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'unknown-tool', {}, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('Unknown tool');
  });

  it('emits evidence with all required fields on allowed calls', () => {
    const packet = devPacket('task_ev_1');
    const result = executeToolCall(packet, 'git', { command: 'log' }, TS);
    expect(result.evidence.task_id).toBe('task_ev_1');
    expect(result.evidence.tool_name).toBe('git');
    expect(result.evidence.permission).toBeTruthy();
    expect(result.evidence.timestamp).toBe(TS);
    expect(result.evidence.result_state).toBe('allowed');
    expect(result.evidence.artifact).toContain('task_ev_1');
  });

  it('emits evidence with all required fields on denied calls', () => {
    const packet = reviewerPacket('task_ev_2');
    const result = executeToolCall(packet, 'github-merge', { pr_number: 1 }, TS);
    expect(result.evidence.task_id).toBe('task_ev_2');
    expect(result.evidence.tool_name).toBe('github-merge');
    expect(result.evidence.timestamp).toBe(TS);
    expect(result.evidence.result_state).toBe('denied');
    expect(result.evidence.artifact).toBeNull();
  });
});

describe('tool-enforcement — read-only roles', () => {
  it('reviewer (read-only) can use github-api', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-api', { method: 'GET', path: '/repos' }, TS);
    expect(result.result_state).toBe('allowed');
  });

  it('reviewer (read-only) can use filesystem', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'filesystem', { path: '/tmp' }, TS);
    expect(result.result_state).toBe('allowed');
  });

  it('read-only role cannot call write tools (github-merge)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-merge', { pr_number: 1 }, TS);
    expect(result.result_state).toBe('denied');
  });

  it('read-only role cannot call push tools (github-push)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-push', { branch: 'main' }, TS);
    expect(result.result_state).toBe('denied');
  });

  it('read-only role cannot call label tools (github-label)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-label', { labels: ['x'] }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('label');
  });

  it('read-only role cannot call credit tools (credit-charge)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'credit-charge', { amount: 5 }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('credit');
  });

  it('read-only role cannot call deployment tools (github-deploy)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-deploy', { environment: 'prod' }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('deployment');
  });

  it('read-only role cannot call git (write tool)', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'git', { command: 'push' }, TS);
    expect(result.result_state).toBe('denied');
  });

  it('operator (read-only) cannot use github-merge', () => {
    const packet = buildCapabilityPacket('task_op', resolveRoleContract('operator'));
    const result = executeToolCall(packet, 'github-merge', { pr_number: 1 }, TS);
    expect(result.result_state).toBe('denied');
  });
});

describe('tool-enforcement — mutation escalation', () => {
  it('developer (branch-write) can use git', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', { command: 'commit' }, TS);
    expect(result.result_state).toBe('allowed');
  });

  it('developer (branch-write) cannot use github-deploy (deployment tool)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'github-deploy', { environment: 'prod' }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('permission');
  });

  it('developer (branch-write) cannot use credit-charge', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'credit-charge', { amount: 10 }, TS);
    expect(result.result_state).toBe('denied');
  });

  it('commander (external-write) can use github-api', () => {
    const packet = buildCapabilityPacket('task_cmd', resolveRoleContract('commander'));
    const result = executeToolCall(packet, 'github-api', { method: 'POST', path: '/issues' }, TS);
    expect(result.result_state).toBe('allowed');
  });

  it('developer retains only branch-write scope, cannot use github-push directly', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'github-push', { branch: 'main' }, TS);
    // github-push requires repo:write, which developer has — but it's not in the
    // developer's tool list, so it gets caught at dispatch. At execution boundary,
    // the permission check may pass. The dispatch check enforces tool-in-contract.
    const resolved = resolveRoleContract('developer');
    const dispatchResult = checkDispatchTool(resolved, 'task_1', 'github-push', TS);
    expect(dispatchResult.allowed).toBe(false);
    expect(dispatchResult.reason).toContain('not in role contract');
  });
});

describe('tool-enforcement — malformed inputs', () => {
  it('rejects null input', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', null, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('Malformed input');
  });

  it('rejects undefined input', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', undefined, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('Malformed input');
  });

  it('rejects non-object input (string)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', 'not an object', TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('Malformed input');
  });

  it('rejects non-object input (number)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', 42, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('expected an object');
  });

  it('rejects array input', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', [1, 2, 3], TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('expected an object');
  });

  it('rejects wrong type for a declared field (number where string expected)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', { command: 123 }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('must be a string');
  });

  it('rejects wrong type for a declared field (string where array expected)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', { args: 'not-an-array' }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('must be an array');
  });

  it('rejects wrong type for a declared field (string where number expected)', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'github-merge', { pr_number: 'not-a-number' }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('must be a number');
  });

  it('allows an empty object as valid input', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', {}, TS);
    expect(result.result_state).toBe('allowed');
  });

  it('allows input with correct types', () => {
    const packet = devPacket();
    const result = executeToolCall(packet, 'git', { command: 'status', args: ['--short'] }, TS);
    expect(result.result_state).toBe('allowed');
  });
});

describe('tool-enforcement — evidence emission', () => {
  it('emitToolCallEvidence produces a complete evidence record', () => {
    const evidence = emitToolCallEvidence(
      'task_e1',
      'git',
      'repo:read,repo:write',
      'allowed',
      'artifact:task_e1/git',
      TS
    );
    expect(evidence.task_id).toBe('task_e1');
    expect(evidence.tool_name).toBe('git');
    expect(evidence.permission).toBe('repo:read,repo:write');
    expect(evidence.timestamp).toBe(TS);
    expect(evidence.result_state).toBe('allowed');
    expect(evidence.artifact).toBe('artifact:task_e1/git');
  });

  it('emitToolCallEvidence records denied calls with null artifact', () => {
    const evidence = emitToolCallEvidence(
      'task_e2',
      'github-merge',
      'none',
      'denied',
      null,
      TS
    );
    expect(evidence.result_state).toBe('denied');
    expect(evidence.artifact).toBeNull();
  });

  it('every ToolCallResult has a non-null evidence object', () => {
    const packet = devPacket('task_ev3');
    const allowed = executeToolCall(packet, 'git', { command: 'log' }, TS);
    expect(allowed.evidence).toBeDefined();
    expect(typeof allowed.evidence).toBe('object');

    const denied = executeToolCall(reviewerPacket('task_ev4'), 'github-merge', { pr_number: 1 }, TS);
    expect(denied.evidence).toBeDefined();
    expect(typeof denied.evidence).toBe('object');
  });
});

describe('tool-enforcement — denied calls are explicit failures', () => {
  it('a denied call has result_state "denied", not omitted', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-merge', { pr_number: 1 }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.evidence.result_state).toBe('denied');
    expect(result.artifact).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('a denied call due to permission absence has a descriptive reason', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'credit-charge', { amount: 5 }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('credit-charge');
    expect(result.reason).toContain('permission');
  });

  it('a denied call due to read-only violation has a descriptive reason', () => {
    const packet = reviewerPacket();
    const result = executeToolCall(packet, 'github-label', { labels: ['x'] }, TS);
    expect(result.result_state).toBe('denied');
    expect(result.reason).toContain('read-only');
  });
});

describe('tool-enforcement — assert helpers throw', () => {
  it('assertToolInRoleContract throws for tool not in contract', () => {
    const resolved = resolveRoleContract('reviewer');
    expect(() => assertToolInRoleContract(resolved, 'git')).toThrow(ToolEnforcementError);
  });

  it('assertPermissionsInCapabilityPacket throws when permission absent', () => {
    const packet = reviewerPacket();
    expect(() => assertPermissionsInCapabilityPacket(packet, 'github-merge')).toThrow(ToolEnforcementError);
  });

  it('assertReadOnlyNotViolated throws for read-only role using write tool', () => {
    const packet = reviewerPacket();
    expect(() => assertReadOnlyNotViolated(packet, 'github-merge')).toThrow(ToolEnforcementError);
  });

  it('assertReadOnlyNotViolated does not throw for non-read-only role', () => {
    const packet = devPacket();
    expect(() => assertReadOnlyNotViolated(packet, 'github-merge')).not.toThrow();
  });

  it('validateToolInput throws for null', () => {
    expect(() => validateToolInput('git', null)).toThrow(ToolEnforcementError);
  });

  it('getToolDefinition throws for unknown tool', () => {
    expect(() => getToolDefinition('nope')).toThrow(ToolEnforcementError);
  });

  it('ToolEnforcementError has a code property', () => {
    try {
      getToolDefinition('nope');
      fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolEnforcementError);
      expect((e as ToolEnforcementError).code).toBe('unknown_tool');
    }
  });
});

describe('tool-enforcement — integration with role contracts', () => {
  it('all tools in all role contracts are present in the tool catalog', () => {
    const { ROLE_NAMES, ROLE_CONTRACTS } = require('../lib/role-contracts');
    for (const role of ROLE_NAMES) {
      const contract = ROLE_CONTRACTS[role];
      for (const tool of contract.tools) {
        expect(TOOL_CATALOG[tool.name]).toBeDefined();
      }
    }
  });

  it('developer tasks retain only branch-write scope', () => {
    const resolved = resolveRoleContract('developer');
    expect(resolved.mutation_policy).toBe('branch-write');
    // developer cannot dispatch github-deploy or credit-charge
    expect(checkDispatchTool(resolved, 'task_1', 'github-deploy', TS).allowed).toBe(false);
    expect(checkDispatchTool(resolved, 'task_1', 'credit-charge', TS).allowed).toBe(false);
  });

  it('reviewer tasks are read-only', () => {
    const resolved = resolveRoleContract('reviewer');
    expect(resolved.mutation_policy).toBe('read-only');
    // reviewer can use github-api and filesystem
    expect(checkDispatchTool(resolved, 'task_1', 'github-api', TS).allowed).toBe(true);
    expect(checkDispatchTool(resolved, 'task_1', 'filesystem', TS).allowed).toBe(true);
    // reviewer cannot use write-only tools
    expect(checkDispatchTool(resolved, 'task_1', 'github-merge', TS).allowed).toBe(false);
    expect(checkDispatchTool(resolved, 'task_1', 'github-push', TS).allowed).toBe(false);
    expect(checkDispatchTool(resolved, 'task_1', 'github-label', TS).allowed).toBe(false);
    expect(checkDispatchTool(resolved, 'task_1', 'credit-charge', TS).allowed).toBe(false);
    expect(checkDispatchTool(resolved, 'task_1', 'github-deploy', TS).allowed).toBe(false);
  });
});
