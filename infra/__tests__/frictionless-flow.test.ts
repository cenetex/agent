import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../..');
const stack = readFileSync(resolve(repoRoot, 'infra/lib/stack.ts'), 'utf8');
const webhook = readFileSync(resolve(repoRoot, 'infra/lib/webhook-handler.ts'), 'utf8');
const deploy = readFileSync(resolve(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

describe('frictionless pull request flow', () => {
  it('bypasses the legacy review control plane', () => {
    expect(stack).toContain('FRICTIONLESS_PR_FLOW: "true"');
    expect(webhook).toContain(
      'const FRICTIONLESS_PR_FLOW = process.env.FRICTIONLESS_PR_FLOW !== "false"'
    );
    expect(webhook).toContain('no separate review task is needed');
    expect(webhook).toContain('Ignoring legacy review approval label');
  });

  it('keeps legacy review and merge schedules disabled', () => {
    const reviewRule = stack.slice(
      stack.indexOf('const reviewRule'),
      stack.indexOf('reviewRule.addTarget')
    );
    const mergeRule = stack.slice(
      stack.indexOf('const mergeTriageRule'),
      stack.indexOf('mergeTriageRule.addTarget')
    );

    expect(reviewRule).toContain('enabled: false');
    expect(mergeRule).toContain('enabled: false');
    expect(stack).toContain('MERGE_TRIAGE_AUTO_MERGE: "false"');
  });

  it('deploys accepted changes from main', () => {
    expect(deploy).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(deploy).not.toContain('release:\n');
    expect(deploy).not.toContain('Build and push review agent image');
  });
});
