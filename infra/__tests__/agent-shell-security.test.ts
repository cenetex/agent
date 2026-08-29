import { readFileSync } from 'fs';
import { resolve } from 'path';

const agentRoot = resolve(__dirname, '../../agent');
const common = readFileSync(resolve(agentRoot, 'lib/common.sh'), 'utf8');
const reviewEntrypoint = readFileSync(resolve(agentRoot, 'review-entrypoint.sh'), 'utf8');
const taskEntrypoint = readFileSync(resolve(agentRoot, 'entrypoint.sh'), 'utf8');
const reviewDockerfile = readFileSync(resolve(agentRoot, 'Dockerfile.review'), 'utf8');

describe('agent shell security contracts', () => {
  it('does not grant either Codex workflow unrestricted filesystem access', () => {
    expect(common).not.toContain('sandbox_mode = "danger-full-access"');
    expect(reviewEntrypoint).not.toContain('--sandbox danger-full-access');
    expect(taskEntrypoint).not.toContain('--sandbox danger-full-access');

    expect(reviewEntrypoint).toContain('--sandbox read-only');
    expect(taskEntrypoint).toContain('--sandbox workspace-write');
  });

  it('uses a non-inheriting shell environment for attacker-controlled reviews', () => {
    expect(reviewEntrypoint).toContain('configure_codex_openrouter review');
    expect(reviewEntrypoint).toContain('env -i');
    expect(common).toMatch(
      /if \[ "\$\{security_profile\}" = "review" \]; then[\s\S]*?shell_environment_policy='inherit = "none"/
    );
    const codexEnvironment = reviewEntrypoint.slice(
      reviewEntrypoint.indexOf('env -i'),
      reviewEntrypoint.indexOf(
        'timeout 1800 codex --enable use_legacy_landlock exec'
      )
    );
    expect(codexEnvironment).not.toContain('GITHUB_TOKEN=');
    expect(codexEnvironment).not.toContain('GH_TOKEN=');
    expect(codexEnvironment).not.toContain('AWS_ACCESS_KEY_ID=');
    expect(codexEnvironment).not.toContain('AWS_SECRET_ACCESS_KEY=');
    expect(codexEnvironment).not.toContain('AWS_SESSION_TOKEN=');
    expect(codexEnvironment).not.toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=');
    expect(codexEnvironment).not.toContain('AWS_CONTAINER_AUTHORIZATION_TOKEN=');
    expect(codexEnvironment).not.toContain('ARTIFACT');
    expect(codexEnvironment).toContain('AWS_EC2_METADATA_DISABLED="true"');
    expect(codexEnvironment).toContain('AWS_CONFIG_FILE="/dev/null"');
    expect(codexEnvironment).toContain('AWS_SHARED_CREDENTIALS_FILE="/dev/null"');
    expect(codexEnvironment).toContain('GIT_CONFIG_GLOBAL="/dev/null"');
    expect(codexEnvironment).toContain('GIT_TERMINAL_PROMPT="0"');
    expect(common).not.toContain('set = { GITHUB_TOKEN');
    expect(common).not.toContain('set = { GH_TOKEN');
    expect(common).not.toContain('set = { OPENROUTER_API_KEY');
    expect(common).not.toContain('AWS_ACCESS_KEY_ID');
    expect(common).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(common).not.toContain('AWS_SESSION_TOKEN');
    expect(common).not.toContain('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI');
    expect(common).not.toContain('AWS_CONTAINER_AUTHORIZATION_TOKEN');
    expect(common).toContain('AWS_EC2_METADATA_DISABLED = "true"');
    expect(common).toContain('AWS_CONFIG_FILE = "/dev/null"');
    expect(common).toContain('AWS_SHARED_CREDENTIALS_FILE = "/dev/null"');
    expect(common).toContain('GIT_CONFIG_GLOBAL = "/dev/null"');
    expect(common).toContain('GIT_TERMINAL_PROMPT = "0"');
  });

  it('uses a non-inheriting shell environment for implementation workers', () => {
    expect(common).toMatch(
      /local security_profile="\$\{1:-task\}"[\s\S]*?shell_environment_policy='inherit = "none"/
    );
    expect(taskEntrypoint).toContain('env -i');
    expect(taskEntrypoint).not.toContain('push anyway');
    expect(taskEntrypoint).not.toContain(
      "gh pr create --title '<title>'"
    );
  });

  it('never embeds an installation token in a git remote', () => {
    for (const source of [common, reviewEntrypoint, taskEntrypoint]) {
      expect(source).not.toContain('x-access-token:');
    }

    expect(common).toContain('gh auth setup-git --hostname github.com --force');
    expect(reviewEntrypoint).toContain('https://github.com/${REPO}.git');
    expect(taskEntrypoint).toContain('https://github.com/${REPO}.git');
  });

  it('captures schema-validated review output outside model shell commands', () => {
    expect(reviewEntrypoint).toContain('--output-schema "${REVIEW_FINDINGS_SCHEMA}"');
    expect(reviewEntrypoint).toContain('--output-last-message "${REVIEW_FINDINGS_FILE}"');
    expect(reviewEntrypoint).toContain('--ignore-rules');
    expect(reviewDockerfile).toContain(
      'COPY review-findings.schema.json /lib/review-findings.schema.json'
    );
  });

  it('binds bot review attestations to the exact reviewed head', () => {
    expect(reviewEntrypoint).toContain(
      '<!-- cenetex-review-attestation:v1 head=${HEAD_SHA} decision=${decision} task=${TASK_ID} -->'
    );
    expect(reviewEntrypoint).toContain(
      'using the bot attestation'
    );
  });

  it('uses the namespace-free Linux sandbox backend on Fargate', () => {
    expect(reviewEntrypoint).toContain(
      'timeout 1800 codex --enable use_legacy_landlock exec'
    );
    expect(reviewEntrypoint).toContain('--sandbox read-only');
  });

  it('does not install dependencies selected by an untrusted PR', () => {
    expect(reviewEntrypoint).not.toContain('python -m pip install');
    expect(reviewEntrypoint).not.toContain('REVIEW_INSTALL_DEPENDENCIES');
    expect(reviewEntrypoint).toContain(
      'dependency installation is disabled for untrusted reviews'
    );
  });

  it('checks exact git blob size rather than estimating bytes from line count', () => {
    expect(reviewEntrypoint).toContain(
      'git cat-file -s "${HEAD_SHA}:${file}"'
    );
    expect(reviewEntrypoint).not.toContain('file_additions / 10');
  });
});
