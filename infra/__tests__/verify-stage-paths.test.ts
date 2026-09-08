import { readFileSync } from 'fs';
import { resolve } from 'path';

const agentRoot = resolve(__dirname, '../../agent');
const entrypoint = readFileSync(resolve(agentRoot, 'entrypoint.sh'), 'utf8');
const common = readFileSync(resolve(agentRoot, 'lib/common.sh'), 'utf8');

const grooming = readFileSync(
  resolve(__dirname, '../lib/grooming-handler.ts'),
  'utf8'
);

describe('harness verify stage — publish-then-clean queue paths (issue #640)', () => {
  describe('records PR URL, pushed branch head, and CI conclusion', () => {
    it('update_task_metadata accepts pushed_head_sha and ci_conclusion fields', () => {
      expect(entrypoint).toContain('local pushed_head_sha="${5:-}"');
      expect(entrypoint).toContain('local ci_conclusion="${6:-}"');
      expect(entrypoint).toContain(
        'pushed_head_sha: (if $pushed_head_sha == "" then null else $pushed_head_sha end)'
      );
      expect(entrypoint).toContain(
        'ci_conclusion: (if $ci_conclusion == "" then null else $ci_conclusion end)'
      );
    });

    it('common.sh provides get_pr_head_sha and get_pr_ci_conclusion helpers', () => {
      expect(common).toContain('get_pr_head_sha()');
      expect(common).toContain('get_pr_ci_conclusion()');
      expect(common).toContain('get_pr_failing_checks()');
      expect(common).toContain('find_pr_for_issue()');
    });

    it('verify stage captures pushed head and CI conclusion from the PR', () => {
      expect(entrypoint).toContain(
        'PUSHED_HEAD_SHA="$(get_pr_head_sha "${PR_NUM}" "${REPO}")"'
      );
      expect(entrypoint).toContain(
        'CI_CONCLUSION="$(get_pr_ci_conclusion "${PR_NUM}" "${REPO}")"'
      );
    });

    it('on_exit passes pushed head and CI conclusion to metadata on success', () => {
      expect(entrypoint).toContain(
        'update_task_metadata "succeeded" "" "$pr_url" "" "${PUSHED_HEAD_SHA}" "${CI_CONCLUSION}"'
      );
    });
  });

  describe('CI running — issue stays agent:running with a note', () => {
    it('sets running_ci_pending status when CI is pending', () => {
      expect(entrypoint).toContain('RUN_STATUS="running_ci_pending"');
    });

    it('on_exit keeps agent:running label for running_ci_pending', () => {
      const block = entrypoint.slice(
        entrypoint.indexOf('running_ci_pending'),
        entrypoint.indexOf('Agent keeping agent:running')
      );
      expect(block).toContain('SIGNAL_LABEL_RUNNING');
      expect(block).toContain(
        'update_task_metadata "running" "" "$pr_url" "" "${PUSHED_HEAD_SHA}" "${CI_CONCLUSION}"'
      );
    });

    it('posts a CI-still-running note comment', () => {
      expect(entrypoint).toContain('CI checks are still running for PR');
    });
  });

  describe('CI green on pushed head — mark succeeded', () => {
    it('sets succeeded when CI conclusion is success', () => {
      const verifyBlock = entrypoint.slice(
        entrypoint.indexOf('--- Verify outputs ---'),
        entrypoint.indexOf('elif issue_was_closed')
      );
      expect(verifyBlock).toContain('CI_CONCLUSION');
      expect(verifyBlock).toContain('success)');
      expect(verifyBlock).toContain('RUN_STATUS="succeeded"');
    });
  });

  describe('CI red — record failing jobs and leave re-dispatchable', () => {
    it('sets waiting (not exit 1) when CI fails on a created PR', () => {
      // The old behavior was "exit 1" on CI red; the new behavior sets waiting.
      const verifyBlock = entrypoint.slice(
        entrypoint.indexOf('--- Verify outputs ---'),
        entrypoint.indexOf('elif issue_was_closed')
      );
      expect(verifyBlock).toContain('failure)');
      expect(verifyBlock).toContain('RUN_STATUS="waiting"');
      // Must NOT contain the old "refusing to republish" exit pattern for the
      // issue-created-PR path.
      expect(verifyBlock).not.toContain('refusing to republish over a red branch');
    });

    it('records failing job names in the issue comment', () => {
      expect(entrypoint).toContain('get_pr_failing_checks');
      expect(entrypoint).toContain('The following checks failed');
    });

    it('PR review path also sets waiting instead of exit 1 on CI red', () => {
      // The IS_PR=true branch previously had "exit 1" on CI red (case 1).
      const prBlock = entrypoint.slice(
        entrypoint.indexOf('poll_pr_checks "${ISSUE_NUMBER}"'),
        entrypoint.indexOf('elif [ -n "${PR_URL}" ]')
      );
      expect(prBlock).toContain('leaving re-dispatchable');
      expect(prBlock).not.toContain('refusing to republish');
    });
  });

  describe('does not report verify failure when a PR exists with a pushed branch', () => {
    it('uses the PR_URL from publish_worker_commit first', () => {
      expect(entrypoint).toContain('elif [ -n "${PR_URL}" ]; then');
    });

    it('falls back to find_pr_for_issue (not filtered by run start)', () => {
      expect(entrypoint).toContain(
        'find_pr_for_issue "${ISSUE_NUMBER}" "${REPO}"'
      );
    });

    it('treats no-CI (unknown) as not-a-failure', () => {
      expect(entrypoint).toContain('CI_CONCLUSION="unknown"');
      expect(entrypoint).toContain('No CI checks visible for PR');
    });
  });

  describe('existing-PR re-dispatch', () => {
    it('publish_worker_commit looks up existing PR when gh pr create fails', () => {
      expect(entrypoint).toContain('PR already exists for branch');
      expect(entrypoint).toContain(
        'gh pr list -R "${REPO}" --head "${target_branch}" --state open'
      );
    });

    it('accepts the existing PR head ref as a valid worker branch', () => {
      expect(entrypoint).toContain('EXISTING_PR_HEAD_REF');
      expect(entrypoint).toContain(
        '"${target_branch}" = "${EXISTING_PR_HEAD_REF}"'
      );
    });

    it('instructs the worker to check out the existing PR branch', () => {
      expect(entrypoint).toContain('You MUST re-use this existing PR branch');
      expect(entrypoint).toContain('git checkout ${EXISTING_PR_HEAD_REF}');
    });
  });

  describe('stale agent:running is reaped and re-queued', () => {
    it('removes agent:running and re-adds the agent trigger label', () => {
      expect(grooming).toContain('Reaped stale agent:running');
      expect(grooming).toContain('DELETE');
      expect(grooming).toContain('encodeURIComponent("agent:running")');
      expect(grooming).toContain('labels: [AGENT_LABEL]');
    });

    it('posts a reap-and-requeue comment', () => {
      expect(grooming).toContain('reaped and re-queued');
    });
  });

  describe('npm sandbox network policy is documented', () => {
    it('SECURITY.md documents the npm registry block', () => {
      const security = readFileSync(resolve(__dirname, '../../SECURITY.md'), 'utf8');
      expect(security).toContain('registry.npmjs.org');
      expect(security).toContain('EAI_AGAIN');
      expect(security).toContain('Unknown');
    });

    it('orchestrate-lint.sh documents the Unknown fallback', () => {
      const lintScript = readFileSync(
        resolve(agentRoot, 'lib/orchestrate-lint.sh'),
        'utf8'
      );
      expect(lintScript).toContain('Network policy note');
      expect(lintScript).toContain('EAI_AGAIN');
      expect(lintScript).toContain('Unknown');
    });
  });
});
