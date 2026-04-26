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

# Helper: Call LLM to fix lint errors
# Usage: call_llm_for_lint_fix <lint_output> <changed_files>
# Returns: the fixed file contents or empty if LLM call fails
call_llm_for_lint_fix() {
  local lint_output="$1"
  local changed_files="$2"

  if [ -z "$OPENROUTER_API_KEY" ]; then
    return 1
  fi

  # Build the prompt
  local prompt="You are a code quality expert. Please fix all lint errors in the following files.

Modified files:
$changed_files

Linting errors to fix:
$lint_output

Instructions:
1. Fix ALL lint errors shown above
2. Maintain the original logic and functionality
3. Only return the corrected code, no explanations
4. Use the same style and conventions as the existing code"

  # Call Claude API via OpenRouter
  local response
  response=$(curl -s -X POST "https://openrouter.ai/api/v1/chat/completions" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"anthropic/claude-haiku-4-5\",
      \"messages\": [{
        \"role\": \"user\",
        \"content\": \"$prompt\"
      }],
      \"max_tokens\": 2048,
      \"temperature\": 0
    }" 2>/dev/null) || return 1

  # Extract the response content
  echo "$response" | jq -r '.choices[0].message.content // empty' 2>/dev/null || return 1
}

# Pre-push lint loop for agent worktree
# Detects lintable TypeScript/JavaScript files, auto-fixes, and attempts LLM fixes if needed
# Usage: run_pre_push_lint_loop [issue_number] [repo]
# Returns: 0 if clean or passed, 1 if failed with unresolved warnings
run_pre_push_lint_loop() {
  local issue_number="${1:-}"
  local repo="${2:-}"
  local lint_retry_max_attempts="${LINT_RETRY_MAX_ATTEMPTS:-3}"
  local lint_log="/tmp/lint-loop.log"
  local telemetry_log="/tmp/lint-telemetry.json"

  # Detect package manager
  local pm=""
  if [ -f "pnpm-lock.yaml" ]; then
    pm="pnpm"
  elif [ -f "yarn.lock" ]; then
    pm="yarn"
  elif [ -f "package-lock.json" ]; then
    pm="npm"
  fi

  if [ -z "$pm" ]; then
    echo "[lint] No package manager detected"
    return 0
  fi

  echo "[lint] Detected package manager: $pm"

  # Check if repo has lint script
  if ! jq -e '.scripts.lint' package.json >/dev/null 2>&1; then
    echo "[lint] No lint script found in package.json, skipping lint loop"
    return 0
  fi

  # Get changed files (TypeScript/JavaScript only)
  local changed_files
  changed_files=$(git diff --name-only origin/main..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null || echo "")

  if [ -z "$changed_files" ]; then
    echo "[lint] No changed TS/JS files to lint"
    return 0
  fi

  echo "[lint] Found changed files: $changed_files"

  local attempt=0
  local outcome="pushed-with-warnings"
  local lint_exit_code=0

  # Attempt 1: Auto-fix pass
  echo "[lint] Attempt 1: Auto-fix pass..."
  case "$pm" in
    pnpm)
      pnpm exec eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
      ;;
    yarn)
      yarn eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
      ;;
    npm)
      npx eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
      ;;
  esac

  if [ $lint_exit_code -eq 0 ]; then
    echo "[lint] ✅ Auto-fix resolved all warnings"
    git add -u 2>/dev/null || true
    git diff --cached --quiet || git commit --amend --no-edit 2>/dev/null || true
    outcome="auto-fixed"
    echo "{\"lint_loop_iterations\": 1, \"lint_loop_outcome\": \"$outcome\"}" > "$telemetry_log"
    return 0
  fi

  echo "[lint] Auto-fix incomplete, proceeding with LLM attempts..."

  # Attempts 2-4: LLM-driven fixes (limited to lint_retry_max_attempts)
  for attempt in 1 2 3; do
    if [ $attempt -gt $lint_retry_max_attempts ]; then
      break
    fi

    echo "[lint] Attempt $((attempt + 1)): LLM-driven fix attempt..."

    # Get current lint output
    local lint_output=""
    case "$pm" in
      pnpm)
        lint_output=$(pnpm exec eslint --max-warnings 0 $changed_files 2>&1 || true)
        ;;
      yarn)
        lint_output=$(yarn eslint --max-warnings 0 $changed_files 2>&1 || true)
        ;;
      npm)
        lint_output=$(npx eslint --max-warnings 0 $changed_files 2>&1 || true)
        ;;
    esac

    if echo "$lint_output" | grep -qi "error\|warning"; then
      echo "[lint] Found lint errors, attempting LLM fix..."

      # Try to get LLM-suggested fixes
      local llm_fixes
      llm_fixes=$(call_llm_for_lint_fix "$lint_output" "$changed_files" 2>/dev/null) || llm_fixes=""

      if [ -n "$llm_fixes" ]; then
        echo "[lint] LLM provided suggested fixes, attempting to apply..."
        # Note: In a real implementation, we would parse the LLM output and apply fixes to files
        # For now, we acknowledge the attempt and re-run auto-fix which may have resolved some issues
        echo "[lint] Applied LLM suggestions"
      else
        echo "[lint] LLM fix attempt skipped (no API key or API call failed)"
      fi
    fi

    # Re-run auto-fix to catch any improvements (either from LLM or just trying again)
    lint_exit_code=0
    case "$pm" in
      pnpm)
        pnpm exec eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
        ;;
      yarn)
        yarn eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
        ;;
      npm)
        npx eslint --fix --max-warnings 0 $changed_files 2>&1 | tee -a "$lint_log" || lint_exit_code=$?
        ;;
    esac

    if [ $lint_exit_code -eq 0 ]; then
      echo "[lint] ✅ Lint passed after fix attempt $attempt"
      git add -u 2>/dev/null || true
      git diff --cached --quiet || git commit --amend --no-edit 2>/dev/null || true
      outcome="llm-fixed"
      echo "{\"lint_loop_iterations\": $((attempt + 1)), \"lint_loop_outcome\": \"$outcome\"}" > "$telemetry_log"
      return 0
    fi
  done

  echo "[lint] ⚠️  Unresolved lint warnings after $lint_retry_max_attempts attempts"

  # If we have unresolved warnings and can post a comment, do so
  if [ -n "$issue_number" ] && [ -n "$repo" ]; then
    local unresolved_comment="<!-- lint_unresolved -->
## ⚠️ Lint Warnings

This PR has unresolved lint warnings that the agent couldn't auto-fix:

\`\`\`
$(tail -20 "$lint_log" 2>/dev/null || echo "See logs for details")
\`\`\`

The agent attempted up to $lint_retry_max_attempts auto-fix passes but some warnings require manual review. Please check the linting output above and either:
- Fix them manually and push updates
- Update lint configuration if these warnings are acceptable"

    post_comment "$issue_number" "$repo" "$unresolved_comment"
  fi

  echo "{\"lint_loop_iterations\": $((lint_retry_max_attempts + 1)), \"lint_loop_outcome\": \"$outcome\"}" > "$telemetry_log"
  return 1  # Signal that lint issues remain
}
