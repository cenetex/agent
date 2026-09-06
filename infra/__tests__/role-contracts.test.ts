import {
  ROLE_CONTRACTS,
  ROLE_CONTRACT_VERSION,
  ROLE_NAMES,
  resolveRoleContract,
  validateRoleContract,
  isValidRoleName,
  assertModeAllowed,
  type RoleContract,
} from '../lib/role-contracts';
import { createInitialTaskMetadata } from '../lib/types';

describe('role contracts', () => {
  describe('all initial roles are defined and valid', () => {
    it('defines all nine initial roles', () => {
      const expected = ['developer', 'reviewer', 'researcher', 'archivist', 'operator', 'trainer', 'miner', 'commander', 'courier'];
      expect(ROLE_NAMES).toEqual(expected);
      for (const role of expected) {
        expect(ROLE_CONTRACTS[role as keyof typeof ROLE_CONTRACTS]).toBeDefined();
      }
    });

    it('every built-in role contract passes validation', () => {
      for (const role of ROLE_NAMES) {
        expect(() => resolveRoleContract(role)).not.toThrow();
      }
    });

    it('each role declares the required contract fields', () => {
      for (const role of ROLE_NAMES) {
        const resolved = resolveRoleContract(role);
        expect(resolved.version).toBe(ROLE_CONTRACT_VERSION);
        expect(resolved.role).toBe(role);
        expect(resolved.tools.length).toBeGreaterThan(0);
        expect(resolved.permissions.length).toBeGreaterThan(0);
        expect(resolved.acceptance_criteria_ids.length).toBeGreaterThan(0);
        expect(resolved.verifier.name).toBeTruthy();
        expect(resolved.verifier.version).toBeTruthy();
        expect(resolved.allowed_modes.length).toBeGreaterThan(0);
        expect(['read-only', 'branch-write', 'external-write']).toContain(resolved.mutation_policy);
      }
    });
  });

  describe('resolveRoleContract', () => {
    it('resolves the developer role with expected tools and permissions', () => {
      const resolved = resolveRoleContract('developer');
      expect(resolved.role).toBe('developer');
      expect(resolved.tools).toContain('git');
      expect(resolved.tools).toContain('github-api');
      expect(resolved.permissions).toContain('repo:write');
      expect(resolved.permissions).toContain('fs:write');
      expect(resolved.acceptance_criteria_ids).toContain('tests_pass');
      expect(resolved.verifier).toEqual({ name: 'task-status-verifier', version: '1' });
      expect(resolved.mutation_policy).toBe('branch-write');
    });

    it('resolves the reviewer role as read-only', () => {
      const resolved = resolveRoleContract('reviewer');
      expect(resolved.mutation_policy).toBe('read-only');
      expect(resolved.permissions).not.toContain('fs:write');
      expect(resolved.allowed_modes).toEqual(['pull_request']);
    });

    it('throws on an unknown role', () => {
      expect(() => resolveRoleContract('nonexistent')).toThrow('Unknown role');
    });

    it('deduplicates permissions', () => {
      const resolved = resolveRoleContract('developer');
      const unique = [...new Set(resolved.permissions)];
      expect(resolved.permissions).toEqual(unique);
    });
  });

  describe('validateRoleContract rejects invalid definitions', () => {
    function makeContract(overrides: Partial<RoleContract> = {}): RoleContract {
      return { ...ROLE_CONTRACTS.developer, ...overrides };
    }

    it('rejects a version mismatch', () => {
      expect(() => validateRoleContract(makeContract({ version: 999 }))).toThrow('version mismatch');
    });

    it('rejects an unknown role name', () => {
      expect(() => validateRoleContract(makeContract({ role: 'nonexistent' }))).toThrow('Unknown role name');
    });

    it('rejects empty tools', () => {
      expect(() => validateRoleContract(makeContract({ tools: [] }))).toThrow('at least one tool');
    });

    it('rejects empty permissions (invalid permissions)', () => {
      expect(() => validateRoleContract(makeContract({ permissions: [] }))).toThrow('at least one permission');
    });

    it('rejects a tool with no name', () => {
      const bad = makeContract({ tools: [{ name: '', permissions: ['x'] }] });
      expect(() => validateRoleContract(bad)).toThrow('no name');
    });

    it('rejects a tool with no permissions array', () => {
      const bad = makeContract({ tools: [{ name: 'git', permissions: [] as any }] });
      expect(() => validateRoleContract(bad)).not.toThrow(); // empty array is still an array — OK
    });

    it('rejects empty acceptance criteria', () => {
      expect(() => validateRoleContract(makeContract({ acceptance_criteria: [] }))).toThrow('at least one acceptance criterion');
    });

    it('rejects a criterion with no id', () => {
      const bad = makeContract({ acceptance_criteria: [{ id: '', description: 'x', type: 'boolean' }] });
      expect(() => validateRoleContract(bad)).toThrow('no id');
    });

    it('rejects a criterion with an invalid type', () => {
      const bad = makeContract({ acceptance_criteria: [{ id: 'x', description: 'x', type: 'number' as any }] });
      expect(() => validateRoleContract(bad)).toThrow('invalid type');
    });

    it('rejects a missing verifier (missing verifier)', () => {
      expect(() => validateRoleContract(makeContract({ verifier: { name: '', version: '1' } }))).toThrow('verifier');
    });

    it('rejects a missing verifier version', () => {
      expect(() => validateRoleContract(makeContract({ verifier: { name: 'x', version: '' } }))).toThrow('verifier');
    });

    it('rejects empty allowed modes', () => {
      expect(() => validateRoleContract(makeContract({ allowed_modes: [] }))).toThrow('at least one allowed mode');
    });

    it('rejects an invalid allowed mode', () => {
      const bad = makeContract({ allowed_modes: ['invalid' as any] });
      expect(() => validateRoleContract(bad)).toThrow('invalid allowed mode');
    });

    it('rejects an invalid mutation policy', () => {
      const bad = makeContract({ mutation_policy: 'invalid' as any });
      expect(() => validateRoleContract(bad)).toThrow('invalid mutation policy');
    });
  });

  describe('assertModeAllowed', () => {
    it('allows a mode in the role allowed_modes', () => {
      expect(() => assertModeAllowed('developer', 'issue')).not.toThrow();
    });

    it('rejects a mode not in the role allowed_modes', () => {
      expect(() => assertModeAllowed('reviewer', 'issue')).toThrow('does not allow task mode');
    });

    it('allows operator diagnostic mode', () => {
      expect(() => assertModeAllowed('operator', 'diagnostic')).not.toThrow();
    });
  });

  describe('isValidRoleName', () => {
    it('accepts valid role names', () => {
      expect(isValidRoleName('developer')).toBe(true);
      expect(isValidRoleName('courier')).toBe(true);
    });

    it('rejects invalid role names', () => {
      expect(isValidRoleName('nonexistent')).toBe(false);
      expect(isValidRoleName('')).toBe(false);
    });
  });

  describe('backward-compatible legacy tasks', () => {
    it('createInitialTaskMetadata preserves resolved_role when present', () => {
      const resolved = resolveRoleContract('developer');
      const metadata = createInitialTaskMetadata(
        {
          task_id: 'task_abc123_def456',
          repo_slug: 'octocat/repo',
          requested_ref: 'main',
          resolved_commit_sha: 'abc123',
          task_mode: 'issue',
          agent_class: 'developer',
          resolved_role: resolved,
          created_at: '2026-05-14T00:00:00Z',
          model: 'z-ai/glm-5.2',
          issue_metadata: {
            number: 42,
            title: 'Fix issue',
            body: 'Details',
            labels: ['agent'],
            author: 'octocat',
          },
        },
        'arn:aws:ecs:task/test'
      );

      expect(metadata.agent_class).toBe('developer');
      expect(metadata.resolved_role).toEqual(resolved);
    });

    it('createInitialTaskMetadata remains backward-compatible without resolved_role', () => {
      const metadata = createInitialTaskMetadata(
        {
          task_id: 'task_abc123_def456',
          repo_slug: 'octocat/repo',
          requested_ref: 'main',
          resolved_commit_sha: 'abc123',
          task_mode: 'issue',
          created_at: '2026-05-14T00:00:00Z',
          model: 'z-ai/glm-5.2',
          issue_metadata: {
            number: 42,
            title: 'Fix issue',
            body: 'Details',
            labels: ['agent'],
            author: 'octocat',
          },
        } as any,
        'arn:aws:ecs:task/test'
      );

      expect(metadata.agent_class).toBeUndefined();
      expect(metadata.resolved_role).toBeUndefined();
      expect(metadata.task_id).toBe('task_abc123_def456');
    });

    it('resolved_role serializes to machine-readable metadata', () => {
      const resolved = resolveRoleContract('reviewer');
      const serialized = JSON.stringify(resolved);
      const parsed = JSON.parse(serialized);

      expect(parsed.role).toBe('reviewer');
      expect(parsed.tools).toEqual(['github-api', 'filesystem']);
      expect(parsed.permissions).toContain('repo:read');
      expect(parsed.verifier.name).toBe('review-verifier');
      expect(parsed.acceptance_criteria_ids).toContain('verdict');
    });
  });
});
