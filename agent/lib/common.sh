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
set = { PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME = "/home/agent", USER = "agent", LOGNAME = "agent", LANG = "C.UTF-8", CI = "true", TERM = "dumb" }'
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

# Check if there are agent questions in comments
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
        and (.body | test("\\?"))
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
