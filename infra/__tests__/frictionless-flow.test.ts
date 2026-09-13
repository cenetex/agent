import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../..');
const stack = readFileSync(resolve(repoRoot, 'infra/lib/stack.ts'), 'utf8');
const webhook = readFileSync(resolve(repoRoot, 'infra/lib/webhook-handler.ts'), 'utf8');
const deploy = readFileSync(resolve(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

describe('automated review flow', () => {
  it('runs review by default, with the escape hatch still available', () => {
    expect(stack).toContain('FRICTIONLESS_PR_FLOW: "false"');
    // The env var still disables review when set to "true"; the code path that
    // reads it is unchanged so the switch keeps working in both directions.
    expect(webhook).toContain(
      'const FRICTIONLESS_PR_FLOW = process.env.FRICTIONLESS_PR_FLOW !== "false"'
    );
    expect(webhook).toContain('no separate review task is needed');
  });

  it('gates review on credits and degrades instead of blocking', () => {
    // Running out of money must skip the review, never hold up a merge.
    expect(webhook).toContain('const REVIEW_SKIPPED_NO_CREDITS_LABEL = "review:skipped-no-credits"');
    expect(webhook).toContain('await checkCreditsAvailable(repoSlug, REVIEW_MODEL)');
    expect(webhook).toContain('review is an assist, not a gate');
  });

  it('meters review the same way dispatch is metered', () => {
    // Reserved up front so the #603 reconciliation sweep refunds a failed review.
    expect(webhook).toContain('review (credit reservation)');
    expect(webhook).toContain('MODEL: REVIEW_MODEL');
  });

  it('uses a cheaper model for review than for implementation', () => {
    expect(webhook).toContain('const REVIEW_MODEL = process.env.REVIEW_MODEL || "anthropic/claude-haiku-4-5"');
  });

  it('reviews human-authored PRs, not only bot PRs', () => {
    // Human-authored PRs were the gap: they merged with no automated review.
    expect(webhook).toContain('Deliberately not restricted to bot authors');
    expect(webhook).toContain('Review every opened PR, not only bot-created ones');
  });

  it('enables the review sweeper but keeps auto-merge off', () => {
    const reviewRule = stack.slice(
      stack.indexOf('const reviewRule'),
      stack.indexOf('reviewRule.addTarget')
    );
    const mergeRule = stack.slice(
      stack.indexOf('const mergeTriageRule'),
      stack.indexOf('mergeTriageRule.addTarget')
    );

    expect(reviewRule).toContain('enabled: true');
    // Review advises; a human still merges.
    expect(mergeRule).toContain('enabled: false');
    expect(stack).toContain('MERGE_TRIAGE_AUTO_MERGE: "false"');
  });

  it('deploys accepted changes from main', () => {
    expect(deploy).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(deploy).not.toContain('release:\n');
  });
});
