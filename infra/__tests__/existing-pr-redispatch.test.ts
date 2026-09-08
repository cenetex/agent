import { readFileSync } from 'fs';
import { resolve } from 'path';

const agentRoot = resolve(__dirname, '../../agent');
const entrypoint = readFileSync(resolve(agentRoot, 'entrypoint.sh'), 'utf8');
const common = readFileSync(resolve(agentRoot, 'lib/common.sh'), 'utf8');

describe('existing-PR re-dispatch recovery after CI failure (issue #645)', () => {
  describe('worker receives existing PR number and head branch in task packet', () => {
    it('detects the existing PR number and head ref before constructing the mission', () => {
      expect(entrypoint).toContain('EXISTING_PR_NUMBER=$(check_for_existing_agent_pr');
      expect(entrypoint).toContain('EXISTING_PR_HEAD_REF=$(gh api');
      expect(entrypoint).toContain('--jq \'.head.ref\'');
    });

    it('writes a structured task packet with the existing PR details', () => {
      expect(entrypoint).toContain('EXISTING_PR_HEAD_SHA=');
      expect(entrypoint).toContain('EXISTING_PR_CI_CONCLUSION=');
      expect(entrypoint).toContain('EXISTING_PR_CI_FAILURES=');
      expect(entrypoint).toContain('> /tmp/existing-pr.json');
      expect(entrypoint).toContain('existing_pr_number');
      expect(entrypoint).toContain('head_ref');
      expect(entrypoint).toContain('head_sha');
      expect(entrypoint).toContain('ci_conclusion');
    });

    it('tells the worker to check out the existing PR branch, not a new branch', () => {
      // The branch instruction is emitted right before the last MISSION
      // assignment (the issue/developer path), so use lastIndexOf here.
      const block = entrypoint.slice(
        entrypoint.indexOf('BRANCH_INSTRUCTION'),
        entrypoint.lastIndexOf('MISSION="${SYSTEM_INSTRUCTIONS}')
      );
      expect(block).toContain('EXISTING_PR_HEAD_REF');
      expect(block).toContain('Check out the existing PR branch');
      expect(block).toContain('do NOT create a new branch');
      expect(block).toContain('/tmp/existing-pr.json');
    });

    it('falls back to the new-branch instruction when no existing PR exists', () => {
      expect(entrypoint).toContain(
        'Create a branch named agent/issue-${ISSUE_NUMBER}-<short-desc>'
      );
    });
  });

  describe('worker can inspect the failing CI result', () => {
    it('collects the failing CI check names for the existing PR', () => {
      expect(entrypoint).toContain(
        'get_pr_failing_checks "${EXISTING_PR_NUMBER}" "${REPO}"'
      );
      expect(entrypoint).toContain('Failing CI checks on PR #');
      expect(entrypoint).toContain(
        'Inspect these failures and make a focused fix on the existing PR branch.'
      );
    });
  });

  describe('existing PR branch is pre-fetched into the worker worktree', () => {
    it('fetches the existing PR branch and creates a local ref at its head', () => {
      expect(entrypoint).toContain(
        'git fetch origin "${EXISTING_PR_HEAD_REF}" --depth=50'
      );
      expect(entrypoint).toContain(
        'git branch -f "${EXISTING_PR_HEAD_REF}" "${EXISTING_PR_HEAD_SHA}"'
      );
    });
  });

  describe('control plane pushes the fix to the existing PR branch (fast-forward)', () => {
    it('bases the broker patch on the existing PR head when re-dispatching', () => {
      expect(entrypoint).toContain('patch_base="${RESOLVED_COMMIT_SHA}"');
      expect(entrypoint).toContain(
        '"${target_branch}" = "${EXISTING_PR_HEAD_REF}"'
      );
      expect(entrypoint).toContain('patch_base="${EXISTING_PR_HEAD_SHA}"');
    });

    it('fetches the existing PR branch/head into the broker clone', () => {
      const start = entrypoint.indexOf('broker_root="$(mktemp');
      const end = entrypoint.indexOf('if [ "${IS_PR}" = "true" ]; then', start);
      const brokerBlock = entrypoint.slice(start, end);
      expect(brokerBlock).toContain(
        'fetch origin "${target_branch}" --depth=50'
      );
      expect(brokerBlock).toContain('checkout --detach "${patch_base}"');
    });

    it('pushes to the existing PR branch ref (not a protected branch)', () => {
      const start = entrypoint.indexOf('broker_root="$(mktemp');
      const end = entrypoint.indexOf('if [ "${IS_PR}" = "true" ]; then', start);
      const brokerBlock = entrypoint.slice(start, end);
      expect(brokerBlock).toContain(
        'push "https://github.com/${REPO}.git" "HEAD:refs/heads/${target_branch}"'
      );
    });

    it('does not attempt a force push', () => {
      const start = entrypoint.indexOf('broker_root="$(mktemp');
      const end = entrypoint.indexOf('if [ "${IS_PR}" = "true" ]; then', start);
      const brokerBlock = entrypoint.slice(start, end);
      expect(brokerBlock).not.toContain('--force');
      expect(brokerBlock).not.toContain(' -f ');
    });
  });

  describe('issue lifecycle reflects the actual state', () => {
    it('keeps agent:running while CI is pending on the existing PR', () => {
      expect(entrypoint).toContain('running_ci_pending');
      expect(entrypoint).toContain('SIGNAL_LABEL_RUNNING');
    });

    it('marks succeeded when CI is green on the pushed head', () => {
      const verifyBlock = entrypoint.slice(
        entrypoint.indexOf('--- Verify outputs ---'),
        entrypoint.indexOf('elif issue_was_closed')
      );
      expect(verifyBlock).toContain('success)');
      expect(verifyBlock).toContain('RUN_STATUS="succeeded"');
    });

    it('leaves the issue re-dispatchable (waiting) with evidence when CI is red', () => {
      const verifyBlock = entrypoint.slice(
        entrypoint.indexOf('--- Verify outputs ---'),
        entrypoint.indexOf('elif issue_was_closed')
      );
      expect(verifyBlock).toContain('failure)');
      expect(verifyBlock).toContain('RUN_STATUS="waiting"');
      expect(verifyBlock).toContain('get_pr_failing_checks');
      expect(verifyBlock).toContain('re-dispatchable state');
    });
  });

  describe('end-to-end re-dispatch regression', () => {
    it('the existing PR is discovered, fetched, fixed, and pushed on one branch', () => {
      // detection -> structured packet -> pre-fetch -> branch instruction
      expect(entrypoint).toContain('check_for_existing_agent_pr');
      expect(entrypoint).toContain('EXISTING_PR_HEAD_REF');
      expect(entrypoint).toContain('EXISTING_PR_HEAD_SHA');
      expect(entrypoint).toContain('BRANCH_INSTRUCTION');
      // broker bases on existing PR head and pushes to the same branch
      expect(entrypoint).toContain('patch_base');
      expect(entrypoint).toContain('Re-dispatch: basing broker patch on existing PR head');
    });

    it('common.sh provides the CI helpers used by the recovery flow', () => {
      expect(common).toContain('get_pr_head_sha()');
      expect(common).toContain('get_pr_ci_conclusion()');
      expect(common).toContain('get_pr_failing_checks()');
      expect(common).toContain('find_pr_for_issue()');
    });
  });
});
