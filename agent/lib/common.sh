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

  # Configure git identity for commits
  git config --global user.name "github-agent[bot]"
  git config --global user.email "github-agent[bot]@users.noreply.github.com"

  echo "GitHub CLI authentication successful"
  return 0
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
  if echo "$error_message" | grep -qi "insufficient credits"; then
    echo "credit_exhaustion|true|Top up OpenRouter credits via your account dashboard"
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
    echo "pre_flight_failure|false|Check infrastructure requirements: gh CLI, aws CLI, claude CLI"
  elif echo "$stage" | grep -q "run agent"; then
    echo "execution_failure|false|Check the agent logs and issue requirements"
  else
    echo "unknown|false|Review the error details and GitHub App permissions"
  fi
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
