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

# Record a failed task as a feedback example for anti-pattern learning
record_failed_task_feedback() {
  local repo_slug="$1"
  local task_id="$2"
  local issue_title="$3"
  local failure_reason="$4"
  local failure_category="$5"

  if [ -z "$ARTIFACTS_BUCKET" ]; then
    echo "WARNING: ARTIFACTS_BUCKET not set, skipping feedback recording" >&2
    return 1
  fi

  # Generate example ID (simplified: use first 8 chars of task_id + timestamp)
  local example_id="${task_id:0:8}_$(date +%s)"
  local now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local date_part=$(echo "$now" | cut -d'T' -f1)

  # Build failure reason with category
  local full_reason="$failure_reason"
  if [ -n "$failure_category" ]; then
    full_reason="[$failure_category] $failure_reason"
  fi

  # Create feedback example JSON (minimal version - just the essentials)
  local feedback_json=$(cat <<EOF
{
  "example_id": "${example_id}",
  "repo_slug": "${repo_slug}",
  "task_type": "issue",
  "outcome": "failed",
  "task_id": "${task_id}",
  "task_payload": {
    "task_id": "${task_id}",
    "repo_slug": "${repo_slug}",
    "issue_metadata": {
      "title": "${issue_title}"
    }
  },
  "what_was_tried": "Attempted to resolve: ${issue_title}",
  "failure_reason": "${full_reason}",
  "created_at": "${now}",
  "outcome_at": "${now}"
}
EOF
)

  # Store feedback example to S3
  local example_key="feedback-examples/${repo_slug}/failed/${date_part}/${example_id}.json"
  echo "$feedback_json" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${example_key}" --content-type "application/json" 2>/dev/null || {
    echo "WARNING: Failed to record feedback example to S3" >&2
    return 1
  }

  echo "SUCCESS: Recorded failed task feedback example at ${example_key}" >&2

  # Update feedback index (best-effort)
  local index_key="feedback-examples/${repo_slug}/issue/index.json"
  local index_json=$(aws s3 cp "s3://${ARTIFACTS_BUCKET}/${index_key}" - 2>/dev/null || echo '{"repo_slug":"'"${repo_slug}"'","task_type":"issue","examples":[],"updated_at":"'"${now}"'"}')

  # Add new example entry to index
  local updated_index=$(echo "$index_json" | jq --arg example_id "$example_id" --arg outcome "failed" --arg created_at "$now" --arg outcome_at "$now" '
    .examples += [{"example_id": $example_id, "outcome": $outcome, "created_at": $created_at, "outcome_at": $outcome_at}] |
    if .examples | length > 100 then .examples[-100:] else . end |
    .updated_at = $outcome_at
  ')

  echo "$updated_index" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${index_key}" --content-type "application/json" 2>/dev/null || {
    echo "WARNING: Failed to update feedback index" >&2
    return 1
  }

  echo "SUCCESS: Updated feedback index at ${index_key}" >&2
  return 0
}
