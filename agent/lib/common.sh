#!/bin/bash
# Common shell functions shared between agent and review entrypoints

# Set GitHub CLI signal labels
setup_github_auth() {
  local repo="$1"

  echo "Setting up GitHub CLI authentication..."

  # Clear any existing gh auth state to avoid conflicts
  gh auth logout --hostname github.com >/dev/null 2>&1 || true

  # Use environment-based auth (preferred for headless environments)
  export GH_TOKEN="${GITHUB_TOKEN}"

  # Validate authentication by testing repository access
  echo "Validating GitHub App installation token..."
  if ! gh repo view "${repo}" --json nameWithOwner >/dev/null 2>&1; then
    echo "ERROR: Cannot access repository ${repo}"
    echo "GitHub App installation may not have access to this repository"
    return 1
  fi
  echo "Repository access confirmed for ${repo}"

  # Let Git ask gh for credentials at request time. Never persist the
  # installation token in a remote URL where it can leak through logs,
  # diagnostics, or repository configuration.
  if ! gh auth setup-git --hostname github.com --force >/dev/null 2>&1; then
    echo "ERROR: Could not configure GitHub CLI as the git credential helper"
    return 1
  fi

  # Configure git identity for commits
  git config --global user.name "github-agent[bot]"
  git config --global user.email "github-agent[bot]@users.noreply.github.com"

  echo "GitHub CLI authentication successful"
  return 0
}

configure_codex_openrouter() {
  local security_profile="${1:-task}"
  local sandbox_mode="workspace-write"
  local shell_environment_policy='inherit = "none"
set = { PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME = "/home/agent", USER = "agent", LOGNAME = "agent", LANG = "C.UTF-8", CI = "true", TERM = "dumb" }'

  if [ "${security_profile}" = "review" ]; then
    sandbox_mode="read-only"
    # PR contents are attacker-controlled. Give model-spawned commands a fixed,
    # non-secret environment rather than inheriting task credentials.
    shell_environment_policy='inherit = "none"
set = { PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME = "/home/agent", USER = "agent", LOGNAME = "agent", LANG = "C.UTF-8", CI = "true", TERM = "dumb", AWS_EC2_METADATA_DISABLED = "true", AWS_CONFIG_FILE = "/dev/null", AWS_SHARED_CREDENTIALS_FILE = "/dev/null", GIT_CONFIG_GLOBAL = "/dev/null", GIT_TERMINAL_PROMPT = "0" }'
  elif [ "${security_profile}" != "task" ]; then
    echo "ERROR: Unknown Codex security profile: ${security_profile}" >&2
    return 1
  fi

  export CODEX_HOME="${CODEX_HOME:-/home/agent/.codex}"
  mkdir -p "${CODEX_HOME}"

  cat > "${CODEX_HOME}/config.toml" <<EOF
model_provider = "openrouter"
approval_policy = "never"
sandbox_mode = "${sandbox_mode}"
model_context_window = 1048576
model_reasoning_effort = "none"
model_reasoning_summary = "none"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
request_max_retries = 4
stream_max_retries = 10
stream_idle_timeout_ms = 300000

[shell_environment_policy]
${shell_environment_policy}
EOF
}

check_codex_task_sandbox() {
  local codex_command codex_path node_path safe_path
  codex_command="${CODEX_TASK_BIN:-codex-task}"
  codex_path="$(command -v "${codex_command}")" || return 127
  node_path="$(command -v node)" || return 127
  safe_path="${node_path%/*}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

  # Exercise the same file policy and Linux backend as the coding worker.
  # This command is local and uses an empty credential environment.
  env -i \
    PATH="${safe_path}" \
    HOME="/home/agent" \
    USER="agent" \
    LOGNAME="agent" \
    LANG="C.UTF-8" \
    CI="true" \
    TERM="dumb" \
    CODEX_HOME="${CODEX_HOME}" \
    timeout 30 "${codex_path}" --enable use_legacy_landlock sandbox linux \
    --full-auto -- /bin/sh -c \
    'set -eu; test -r .; probe=$(mktemp .agent-sandbox-check.XXXXXX); rm -f "$probe"'
}

start_virtual_display() {
  if [ -n "${DISPLAY:-}" ] || ! command -v Xvfb >/dev/null 2>&1; then
    return 0
  fi

  export DISPLAY="${XVFB_DISPLAY:-:99}"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_SCREEN:-1280x1024x24}" >/tmp/xvfb.log 2>&1 &
}

# Upload artifacts to S3
upload_artifact() {
  local source="$1"
  local s3_key="$2"
  local content_type="${3:-text/plain}"

  if [ -f "${source}" ] && [ -s "${source}" ]; then
    aws s3 cp "${source}" "s3://${ARTIFACTS_BUCKET}/${s3_key}" --content-type "${content_type}" || true
  fi
}

upload_artifact_from_stdin() {
  local content="$1"
  local s3_key="$2"
  local content_type="${3:-text/plain}"

  echo "$content" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${s3_key}" --content-type "${content_type}" || true
}

# Post a comment to GitHub
post_comment() {
  local issue_number="$1"
  local repo="$2"
  local body="$3"

  gh issue comment "${issue_number}" -R "${repo}" --body "$body" >/dev/null 2>&1 || true
}

# Apply labels to GitHub issue/PR
apply_labels() {
  local issue_number="$1"
  local repo="$2"
  shift 2
  local labels=("$@")

  for label in "${labels[@]}"; do
    gh issue edit "${issue_number}" --add-label "${label}" -R "${repo}" >/dev/null 2>&1 || true
  done
}

# Remove labels from GitHub issue/PR
remove_labels() {
  local issue_number="$1"
  local repo="$2"
  shift 2
  local labels=("$@")

  for label in "${labels[@]}"; do
    gh issue edit "${issue_number}" --remove-label "${label}" -R "${repo}" >/dev/null 2>&1 || true
  done
}

# Categorize failure for diagnostics
categorize_failure() {
  local stage="$1"
  local error_message="$2"
  local exit_code="$3"

  # Returns: category|retryable|suggested_action
  # Transient (retryable) failures
  if echo "$error_message" | grep -qiE "HTTP 402|Payment Required|requires more credits|OpenRouter has insufficient credits|insufficient credits"; then
    echo "provider_credit_exhaustion|false|Top up OpenRouter credits via your account dashboard"
  elif echo "$error_message" | grep -qi "timeout\|60 minute"; then
    echo "timeout|true|The task will be retried automatically; you can also retry manually"
  elif echo "$error_message" | grep -qi "openrouter\|connection"; then
    echo "external_service|true|External service is temporarily unavailable; will retry automatically"

  # Permanent (non-retryable) failures
  elif echo "$error_message" | grep -qi "authentication\|auth failed"; then
    echo "auth_failure|false|Check GitHub App installation and token permissions"
  elif echo "$error_message" | grep -qi "permission\|forbidden\|not authorized"; then
    echo "permission_denied|false|The GitHub App lacks required permissions for this repository"
  elif echo "$error_message" | grep -qi "repository\|repo.*not found"; then
    echo "repo_not_found|false|Verify the repository exists and the GitHub App is installed"
  elif [ "$stage" = "pre-flight checks" ]; then
    echo "pre_flight_failure|false|Check infrastructure requirements: gh CLI, aws CLI, codex CLI"
  elif echo "$stage" | grep -q "run agent"; then
    echo "execution_failure|false|Check the agent logs and issue requirements"
  elif echo "$stage" | grep -q "verify outputs"; then
    echo "verify_outputs_failure|false|The code does not typecheck or lint — fix the error and re-label with ${TRIGGER_LABEL:-agent} to retry"
  else
    echo "unknown|false|Review the error details and GitHub App permissions"
  fi
}

detect_provider_credit_exhaustion() {
  local log_file="$1"

  if [ ! -f "$log_file" ] || [ ! -s "$log_file" ]; then
    return 1
  fi

  grep -qiE "HTTP 402|Payment Required|requires more credits|OpenRouter has insufficient credits" "$log_file"
}

# Check if a comment already exists
comment_already_exists() {
  local task_id="$1"
  local issue_number="$2"
  local repo="$3"

  # Check if a comment with this task ID already exists (prevent duplicates)
  gh api "repos/${repo}/issues/${issue_number}/comments?per_page=100" \
    --jq ".[] | select(.body | contains(\"<!-- task_id: ${task_id} -->\")) | .id" \
    2>/dev/null | grep -q .
}

# Check if issue was closed
issue_was_closed() {
  local issue_number="$1"
  local repo="$2"

  local state
  state=$(gh api "repos/${repo}/issues/${issue_number}" --jq '.state' 2>/dev/null)
  [ "$state" = "closed" ]
}

# Find the PR URL created from an issue
find_created_pr_url() {
  local issue_number="$1"
  local repo="$2"
  local since="$3"

  gh api "repos/${repo}/issues/${issue_number}/timeline?per_page=100" \
    -H "Accept: application/vnd.github+json" \
    | jq -r --arg since "${since}" '
      map(
        select(
          .event == "cross-referenced"
          and .created_at >= $since
          and .source.issue.pull_request.html_url != null
        )
      )
      | last
      | .source.issue.html_url // empty
    '
}

# Find any open PR that references the issue (not filtered by run start).
# Used by the verify stage on re-dispatch, where the PR was created in a
# prior run and find_created_pr_url (which filters by since) would miss it.
find_pr_for_issue() {
  local issue_number="$1"
  local repo="$2"

  gh api "repos/${repo}/pulls?state=open&per_page=100" \
    --jq '[.[] | select(.body != null) | select(.body | test("(Fixes|Closes|Resolves) #'"${issue_number}"'(\\b|$)")) | .html_url] | first // empty' \
    2>/dev/null || true
}

# Get the head SHA pushed to a PR branch.
get_pr_head_sha() {
  local pr_number="$1"
  local repo="$2"

  gh api "repos/${repo}/pulls/${pr_number}" --jq '.head.sha' 2>/dev/null || true
}

# Get the CI check conclusion for a PR head as a single string:
#   success | failure | pending | unknown
get_pr_ci_conclusion() {
  local pr_number="$1"
  local repo="$2"

  local head_sha
  head_sha="$(get_pr_head_sha "${pr_number}" "${repo}")"
  if [ -z "${head_sha}" ]; then
    echo "unknown"
    return 0
  fi

  local status_json
  status_json="$(gh api "repos/${repo}/commits/${head_sha}/check-runs" 2>/dev/null)" || {
    echo "unknown"
    return 0
  }

  local total_count in_progress_count failure_count
  total_count="$(echo "${status_json}" | jq '.total_count // 0')"
  in_progress_count="$(echo "${status_json}" | jq '[.check_runs[]? | select(.status != "completed")] | length')"
  failure_count="$(echo "${status_json}" | jq '[.check_runs[]? | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out")] | length')"

  if [ "${total_count}" -eq 0 ]; then
    echo "unknown"
  elif [ "${in_progress_count}" -gt 0 ]; then
    echo "pending"
  elif [ "${failure_count}" -gt 0 ]; then
    echo "failure"
  else
    echo "success"
  fi
}

# List the names of failing CI check-runs for a PR head.
get_pr_failing_checks() {
  local pr_number="$1"
  local repo="$2"

  local head_sha
  head_sha="$(get_pr_head_sha "${pr_number}" "${repo}")"
  if [ -z "${head_sha}" ]; then
    return 0
  fi

  gh api "repos/${repo}/commits/${head_sha}/check-runs" 2>/dev/null \
    | jq -r '[.check_runs[]? | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | .name] | unique | .[]' \
    2>/dev/null || true
}

# Check for a question comment posted since the run started.
#
# This previously matched any comment body containing "?", which meant the
# runtime's own status comments qualified: they carry artifact URLs of the form
# ".../?prefix=tasks/...". The call site at entrypoint.sh sets RUN_STATUS to
# "waiting" on a match, so a bot status comment could freeze an issue in
# agent:waiting with no question for anyone to answer. #422 and #415 have been
# stuck that way since June and July respectively.
#
# Agents no longer post comments -- they write /tmp/agent-question.json -- so in
# practice this now detects a human asking something mid-run. Bot authors are
# excluded outright and URLs are stripped before the "?" test. The explicit
# marker branch is kept for any caller that does signal via a comment.
has_agent_question_comment() {
  local issue_number="$1"
  local repo="$2"
  local since="$3"

  local comments_json
  comments_json="$(gh api "repos/${repo}/issues/${issue_number}/comments?per_page=100")"

  jq -e --arg since "${since}" '
    map(
      select(
        .created_at >= $since
        and (
          # Explicit marker, for any caller that signals a question in a comment.
          (.body | test("<!-- *agent-question *-->"; "i"))
          # Otherwise: a human asking something. Bots are excluded outright, and
          # URLs are stripped before looking for "?" so a query string cannot
          # read as a question.
          or (
            (.user.type // "") != "Bot"
            and ((.body | gsub("https?://[^\\s)\"]+"; "")) | test("\\?"))
          )
        )
      )
    )
    | length > 0
  ' >/dev/null <<<"${comments_json}"
}

# Check if acceptance criteria are met
# Returns 0 if all criteria are met, 1 if any unmet
check_acceptance_criteria() {
  local criteria_file="$1"

  if [ ! -f "$criteria_file" ]; then
    # No criteria check file found — assume criteria checking not needed
    return 0
  fi

  if ! jq empty "$criteria_file" 2>/dev/null; then
    # Invalid JSON
    echo "WARNING: Invalid JSON in criteria check file: $criteria_file" >&2
    return 0
  fi

  # Check if any criteria are marked as unmet (met == false)
  if jq -e '.criteria[]? | select(.met == false)' "$criteria_file" >/dev/null 2>&1; then
    return 1  # Unmet criteria found
  fi

  return 0  # All criteria met
}

# Format criteria status for commenting
format_criteria_status() {
  local criteria_file="$1"

  if [ ! -f "$criteria_file" ]; then
    return 0
  fi

  if ! jq empty "$criteria_file" 2>/dev/null; then
    return 0
  fi

  local status_section=""
  status_section="## ✅ Acceptance Criteria Status

"

  # Add met criteria
  if jq -e '.criteria[]? | select(.met == true)' "$criteria_file" >/dev/null 2>&1; then
    status_section="${status_section}### ✅ Met Criteria
"
    while read -r criterion; do
      local desc=$(echo "$criterion" | jq -r '.description')
      local note=$(echo "$criterion" | jq -r '.note // ""')
      status_section="${status_section}- **${desc}**: ${note}
"
    done < <(jq -c '.criteria[]? | select(.met == true)' "$criteria_file")
    status_section="${status_section}
"
  fi

  # Add unmet criteria
  if jq -e '.criteria[]? | select(.met == false)' "$criteria_file" >/dev/null 2>&1; then
    status_section="${status_section}### ❌ Unmet Criteria
"
    while read -r criterion; do
      local desc=$(echo "$criterion" | jq -r '.description')
      local note=$(echo "$criterion" | jq -r '.note // ""')
      status_section="${status_section}- **${desc}**: ${note}
"
    done < <(jq -c '.criteria[]? | select(.met == false)' "$criteria_file")
  fi

  echo "$status_section"
}
