import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

const common = resolve(__dirname, '../../agent/lib/common.sh');

describe('Codex task sandbox startup check', () => {
  it('writes the workspace-write task sandbox config', () => {
    const codexHome = mkdtempSync(resolve(tmpdir(), 'codex-task-profile-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'source "$1"',
        'configure_codex_openrouter task',
      ].join('\n'), 'profile-test', common], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
      });
      expect(result.status).toBe(0);
      const config = readFileSync(resolve(codexHome, 'config.toml'), 'utf8');
      expect(config).toContain('sandbox_mode = "workspace-write"');
      expect(config).not.toContain('default_permissions');
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test.each([0, 22, 124])('preserves sandbox exit code %i', (status) => {
    const result = spawnSync('bash', ['-c', [
      'source "$1"',
      'codex() { :; }',
      'env() { printf "%s\\n" "$@"; return "$SANDBOX_TEST_EXIT"; }',
      'check_codex_task_sandbox',
    ].join('\n'), 'sandbox-test', common], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: '/tmp/codex-sandbox-fixture',
        CODEX_TASK_BIN: 'codex',
        SANDBOX_TEST_EXIT: String(status),
        GITHUB_TOKEN: 'test-secret',
        OPENROUTER_API_KEY: 'test-secret',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
    expect(result.status).toBe(status);
    const args = result.stdout.split('\n');
    expect(args).toContain('-i');
    expect(args).toContain('timeout');
    expect(args).toContain('30');
    expect(args).toContain('use_legacy_landlock');
    expect(args).toContain('sandbox');
    expect(args).toContain('linux');
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('/bin/sh');
    expect(result.stdout).toContain('mktemp .agent-sandbox-check.XXXXXX');
    expect(result.stdout).not.toContain('test-secret');
    expect(args).not.toContain('exec');
  });
});
