#!/bin/bash
set -Eeuo pipefail

# Source common functions
. /lib/common.sh

# --- Required env vars (passed by Lambda via Fargate overrides) ---
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${OPENROUTER_API_KEY:?Missing OPENROUTER_API_KEY}"
: "${ARTIFACTS_BUCKET:?Missing ARTIFACTS_BUCKET}"
: "${ARTIFACT_PREFIX:?Missing ARTIFACT_PREFIX}"
: "${REPO:?Missing REPO}"
: "${PR_NUMBER:?Missing PR_NUMBER}"
: "${REVIEW_CRITERIA:?Missing REVIEW_CRITERIA}"
: "${AWS_REGION:=us-east-1}"

# --- Fetch and parse review payload ---
if [ -n "${REVIEW_PAYLOAD_S3_KEY:-}" ]; then
  echo "Fetching review payload from S3: ${REVIEW_PAYLOAD_S3_KEY}"
  REVIEW_PAYLOAD=$(aws s3 cp "s3://${ARTIFACTS_BUCKET}/${REVIEW_PAYLOAD_S3_KEY}" - --region "${AWS_REGION}" 2>/dev/null) || {
    echo "ERROR: Failed to fetch review payload from S3"
    exit 1
  }
elif [ -n "${REVIEW_PAYLOAD:-}" ]; then
  echo "Using inline review payload from environment"
else
  echo "ERROR: Missing REVIEW_PAYLOAD_S3_KEY or REVIEW_PAYLOAD"
  exit 1
fi

echo "Parsing review payload..."
TASK_ID=$(echo "$REVIEW_PAYLOAD" | jq -r '.task_id')
REPO_SLUG=$(echo "$REVIEW_PAYLOAD" | jq -r '.repo_slug')
HEAD_SHA=$(echo "$REVIEW_PAYLOAD" | jq -r '.head_sha')
BASE_SHA=$(echo "$REVIEW_PAYLOAD" | jq -r '.base_sha')
PR_TITLE=$(echo "$REVIEW_PAYLOAD" | jq -r '.pr_metadata.title')
PR_AUTHOR=$(echo "$REVIEW_PAYLOAD" | jq -r '.pr_metadata.author')
CREATED_AT=$(echo "$REVIEW_PAYLOAD" | jq -r '.created_at')

# Extract repo owner and name from slug
REPO_OWNER=$(echo "$REPO_SLUG" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO_SLUG" | cut -d'/' -f2)

echo "=== Review Task Starting ==="
echo "Task ID: $TASK_ID"
echo "Repository: $REPO_SLUG"
echo "PR #$PR_NUMBER: $PR_TITLE"
echo "Author: $PR_AUTHOR"
echo "HEAD SHA: $HEAD_SHA"
echo "BASE SHA: $BASE_SHA"
echo "Created at: $CREATED_AT"

CURRENT_STAGE="startup"
REVIEW_STATUS="error"
RUN_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
REVIEW_LOG="/tmp/review-output.log"

REVIEW_APPROVED_LABEL="review:approved"
REVIEW_CHANGES_REQUESTED_LABEL="review:changes-requested"
REVIEW_ERROR_LABEL="review:error"
REVIEW_HUMAN_REQUIRED_LABEL="review:human-required"
REVIEW_IN_PROGRESS_LABEL="review:in-progress"

# S3 artifact keys
METADATA_KEY="${ARTIFACT_PREFIX}/review-metadata.json"
LOG_KEY="${ARTIFACT_PREFIX}/review.log"
RESULT_KEY="${ARTIFACT_PREFIX}/review-result.json"

update_review_status() {
  local status="$1"
  local decision="$2"
  local findings="$3"
  local error_message="$4"
  local completed_at=""

  if [ "$status" != "running" ]; then
    completed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  fi

  # Create updated metadata JSON
  local metadata_json
  metadata_json=$(jq -n \
    --arg task_id "${TASK_ID}" \
    --arg pr_number "${PR_NUMBER}" \
    --arg repo_slug "${REPO_SLUG}" \
    --arg status "${status}" \
    --arg decision "${decision}" \
    --arg created_at "${CREATED_AT}" \
    --arg started_at "${RUN_STARTED_AT}" \
    --arg completed_at "${completed_at}" \
    --arg error_message "${error_message}" \
    '{
      task_id: $task_id,
      pr_number: ($pr_number | tonumber),
      repo_slug: $repo_slug,
      status: $status,
      decision: (if $decision == "" then null else $decision end),
      task_arn: "",
      created_at: $created_at,
      started_at: $started_at,
      error_message: (if $error_message == "" then null else $error_message end)
    } + (if $completed_at == "" then {} else {completed_at: $completed_at} end)')

  # Upload metadata and findings to S3 using common helpers
  upload_artifact_from_stdin "$metadata_json" "${METADATA_KEY}" "application/json"

  # Upload findings if provided
  if [ -n "$findings" ]; then
    upload_artifact_from_stdin "$findings" "${RESULT_KEY}" "application/json"
  fi
}

upload_review_artifacts() {
  # Upload review log using common helper
  upload_artifact "${REVIEW_LOG}" "${LOG_KEY}" "text/plain"
}

format_review_findings() {
  local findings_json="$1"

  # Use jq to format the findings as markdown
  echo "$findings_json" | jq -r '
    def status_icon: if . == "pass" then "✅" elif . == "fail" then "❌" elif . == "warn" then "⚠️" else "❓" end;

    "### Forbidden Files: \(.findings.forbidden_files.status | status_icon)\n\(.findings.forbidden_files.details // "")\n" +
    "\n### Compilation/Linting: \(.findings.compilation.status | status_icon)\n\(.findings.compilation.details // "")\n" +
    "\n### Security: \(.findings.security.status | status_icon)\n" +
    (if (.findings.security.issues | length) > 0 then
      "Issues found:\n" + (.findings.security.issues | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Issue Alignment: \(.findings.issue_alignment.status | status_icon)\n\(.findings.issue_alignment.details // "")\n" +
    "\n### Logic: \(.findings.logic.status | status_icon)\n" +
    (if (.findings.logic.issues | length) > 0 then
      "Issues found:\n" + (.findings.logic.issues | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Complexity: \(.findings.complexity.status | status_icon)\n\(.findings.complexity.details // "")\n" +
    "\n### Cost Impact: \(.findings.cost_impact.status | status_icon)\n\(.findings.cost_impact.details // "")\n" +
    "\n### Scope: \(.findings.scope.status | status_icon)\n\(.findings.scope.details // "")\n"
  '
}

post_review_comment() {
  local decision="$1"
  local findings="$2"

  local comment_body=""
  case "$decision" in
    "approved")
      comment_body="✅ **Automated Review: APPROVED**

This PR has been reviewed by the agent and is approved for merging.

**Review Details:**
$findings

The PR will be automatically merged after a 1-hour hold period unless manually intervened.

🔄 **Labels Applied:** \`review:approved\`
⏱️ **Auto-merge:** Scheduled for $(date -d '+1 hour' '+%Y-%m-%d %H:%M UTC')

To prevent auto-merge, remove the \`review:approved\` label or close this PR.

*Task ID: \`${TASK_ID}\`*"
      ;;
    "changes_requested")
      comment_body="❌ **Automated Review: CHANGES REQUESTED**

The automated review has identified issues that need to be addressed before this PR can be merged.

**Review Details:**
$findings

Please address these issues and push new commits. The review will run again automatically.

🔄 **Labels Applied:** \`review:changes-requested\`

*Task ID: \`${TASK_ID}\`*"
      ;;
    "error")
      comment_body="🔧 **Automated Review: ERROR**

The automated review encountered an error and could not complete.

**Error Details:**
$findings

This PR will require manual review.

🔄 **Labels Applied:** \`review:error\`

*Task ID: \`${TASK_ID}\`*"
      ;;
  esac

  # Post the review comment using common helper
  post_comment "${PR_NUMBER}" "${REPO}" "$comment_body" 2>&1 | tee -a "${REVIEW_LOG}" || true
}

apply_review_labels() {
  local decision="$1"
  local result_label=""

  gh label create "${REVIEW_APPROVED_LABEL}" -R "${REPO}" --color "0E8A16" \
    --description "Automated review approved this pull request" --force >/dev/null
  gh label create "${REVIEW_CHANGES_REQUESTED_LABEL}" -R "${REPO}" --color "D73A4A" \
    --description "Automated review requested changes" --force >/dev/null
  gh label create "${REVIEW_ERROR_LABEL}" -R "${REPO}" --color "D73A4A" \
    --description "Automated review could not complete" --force >/dev/null
  gh label create "${REVIEW_HUMAN_REQUIRED_LABEL}" -R "${REPO}" --color "B60205" \
    --description "Manual human review is required before merge" --force >/dev/null
  gh label create "${REVIEW_IN_PROGRESS_LABEL}" -R "${REPO}" --color "EDEDED" \
    --description "Automated review is currently running" --force >/dev/null

  # Remove any existing review labels
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "${REVIEW_APPROVED_LABEL}" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "${REVIEW_CHANGES_REQUESTED_LABEL}" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "${REVIEW_ERROR_LABEL}" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "${REVIEW_HUMAN_REQUIRED_LABEL}" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "${REVIEW_IN_PROGRESS_LABEL}" 2>/dev/null || true

  case "$decision" in
    "approved")
      result_label="${REVIEW_APPROVED_LABEL}"
      ;;
    "changes_requested")
      result_label="${REVIEW_CHANGES_REQUESTED_LABEL}"
      ;;
    "error")
      result_label="${REVIEW_ERROR_LABEL}"
      ;;
  esac

  if [ -z "${result_label}" ]; then
    echo "ERROR: Unknown review decision for label application: ${decision}" | tee -a "${REVIEW_LOG}"
    return 1
  fi

  if ! gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "${result_label}" >>"${REVIEW_LOG}" 2>&1; then
    echo "ERROR: Failed to apply ${result_label} to ${REPO}#${PR_NUMBER}" | tee -a "${REVIEW_LOG}"
    return 1
  fi

  echo "Applied ${result_label} to ${REPO}#${PR_NUMBER}" | tee -a "${REVIEW_LOG}"
}

extract_linked_issues() {
  local body="$1"
  local repo_regex=""
  local closing_lines=""
  local issue_urls=""

  repo_regex=$(printf "%s" "${REPO}" | sed -E 's/[][(){}.^$*+?|\\/]/\\&/g')

  closing_lines=$(printf "%s\n" "$body" \
    | grep -Ei '(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?)([[:space:]:]+|$)' \
    || true)
  issue_urls=$(printf "%s\n" "$body" \
    | grep -Eio "https://github\\.com/${repo_regex}/issues/[0-9]+" \
    || true)

  {
    printf "%s\n" "$closing_lines" | grep -Eo '#[0-9]+' || true
    printf "%s\n" "$closing_lines" \
      | grep -Eio "https://github\\.com/${repo_regex}/issues/[0-9]+" \
      | sed -E 's#.*/issues/([0-9]+)#\#\1#' || true
    printf "%s\n" "$issue_urls" | sed -E 's#.*/issues/([0-9]+)#\#\1#' || true
  } | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//'
}

setup_review_dependencies() {
  # Never execute package-manager code selected by an untrusted PR before the
  # sandbox starts. Reviews use the fixed toolchain baked into the image.
  if [ -f "requirements.txt" ]; then
    echo "Python requirements.txt found; dependency installation is disabled for untrusted reviews." | tee -a "${REVIEW_LOG}"
  fi
}

on_exit() {
  local exit_code=$?

  set +e

  # Check if timeout occurred (exit code 124 is the timeout command's exit code)
  if [ "${exit_code}" -eq 124 ]; then
    local error_message="Review execution exceeded 30-minute timeout"
    update_review_status "failed" "error" "" "$error_message"
    upload_review_artifacts
    apply_review_labels "error"
    post_review_comment "error" "Review analysis timed out after 30 minutes. This may indicate the PR is too large or the review criteria are too complex. Please try again or simplify the review scope."

    echo "=== Review timeout ==="
    exit "${exit_code}"
  fi

  if [ "${REVIEW_STATUS}" = "error" ] || [ "${exit_code}" -ne 0 ]; then
    local error_message="Review failed during ${CURRENT_STAGE}"
    local review_error_details="Error during ${CURRENT_STAGE}. Exit code: ${exit_code}"

    if detect_provider_credit_exhaustion "${REVIEW_LOG}"; then
      error_message="OpenRouter has insufficient provider credits for model z-ai/glm-5.2"
      review_error_details="OpenRouter provider credits are exhausted for model \`z-ai/glm-5.2\`. Top up OpenRouter credits, then remove \`review:error\` to let the review scheduler retry."
    fi

    update_review_status "failed" "error" "" "$error_message"
    upload_review_artifacts
    apply_review_labels "error"
    post_review_comment "error" "$review_error_details"

    echo "=== Review failed ==="
    if detect_provider_credit_exhaustion "${REVIEW_LOG}"; then
      exit 0
    fi
    exit "${exit_code}"
  else
    echo "=== Review completed successfully ==="
    exit 0
  fi
}

trap on_exit EXIT

# --- Auth gh CLI ---
CURRENT_STAGE="authenticate GitHub CLI"
if ! setup_github_auth "${REPO}"; then
  exit 1
fi

# --- Clone repo and set up worktree ---
CURRENT_STAGE="clone repository"
echo "Cloning ${REPO}..."
gh repo clone "${REPO}" repo -- --depth=50
cd repo

# Keep credentials out of .git/config. setup_github_auth configured gh as the
# credential helper for authenticated fetches.
git remote set-url origin "https://github.com/${REPO}.git"

# Ensure the exact base and PR head commits are present after the shallow clone.
# GitHub exposes PR heads through refs/pull/<number>/head even when the branch is
# from a fork or is not part of the default clone refspec.
ensure_commit_available() {
  local sha="$1"
  local fetch_ref="$2"
  local label="$3"

  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    return 0
  fi

  echo "Fetching ${label} commit ${sha} from ${fetch_ref}..."
  git fetch --depth=100 origin "${fetch_ref}" 2>&1 | tee -a "${REVIEW_LOG}"

  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "ERROR: Could not fetch ${label} commit ${sha}" | tee -a "${REVIEW_LOG}"
    return 1
  fi
}

ensure_commit_available "${BASE_SHA}" "${BASE_SHA}" "base"
ensure_commit_available "${HEAD_SHA}" "pull/${PR_NUMBER}/head" "PR head"

# --- Create worktrees for base and head ---
CURRENT_STAGE="setup worktrees"
echo "Setting up worktrees for comparison..."

# Create worktree for base branch at base SHA
git worktree add ../base-worktree "$BASE_SHA" 2>&1 | tee -a "${REVIEW_LOG}"

# Create worktree for PR head at head SHA
git worktree add ../pr-worktree "$HEAD_SHA" 2>&1 | tee -a "${REVIEW_LOG}"

echo "Worktrees created:"
echo "- Base: ../base-worktree (${BASE_SHA})"
echo "- PR Head: ../pr-worktree (${HEAD_SHA})"

# --- Fetch PR context ---
CURRENT_STAGE="fetch PR context"
echo "Fetching PR context..."

PR_JSON=$(gh pr view "${PR_NUMBER}" -R "${REPO}" --json number,title,body,headRefName,baseRefName,author,labels,files 2>&1 | tee -a "${REVIEW_LOG}")

# Get the diff
echo "Getting PR diff..."
DIFF=$(gh pr diff "${PR_NUMBER}" -R "${REPO}" 2>&1 | tee -a "${REVIEW_LOG}")

# Get linked issues from PR body. Only closing keywords and same-repo issue URLs
# are treated as task linkage; casual examples like "#12" are just prose.
PR_BODY=$(echo "$PR_JSON" | jq -r '.body // ""')
LINKED_ISSUES=$(extract_linked_issues "$PR_BODY")

# Fetch CI check status
echo "Fetching CI check status..."
CI_CHECKS=$(gh pr checks "${PR_NUMBER}" -R "${REPO}" 2>/dev/null || echo "unavailable")

echo "PR context fetched. Linked issues: ${LINKED_ISSUES:-none}"

# --- Check for forbidden files ---
CURRENT_STAGE="check forbidden files"
echo "Checking for forbidden files..."

FORBIDDEN_FILES=()
FORBIDDEN_PATTERNS=(
  '.backup'
  '.bak'
  '.orig'
  '.env'
  'credentials.'
  'secret'
  '.key'
  '.pem'
  'node_modules/'
  '__pycache__/'
)

# Check for forbidden patterns
while IFS= read -r file; do
  # Skip binary/symlink detection issues
  [[ -z "$file" ]] && continue

  # Check each pattern
  for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
    if [[ "$file" == *"$pattern"* ]]; then
      FORBIDDEN_FILES+=("$file")
      break
    fi
  done

  # Check the exact Git blob size. Addition counts are not byte sizes and report
  # zero for many binaries, so using them as a size proxy is fail-open.
  file_size=$(git cat-file -s "${HEAD_SHA}:${file}" 2>/dev/null || echo 0)
  if [ "$file_size" -gt 512000 ]; then
    FORBIDDEN_FILES+=("$file (large file: ${file_size} bytes)")
  fi
done < <(echo "$PR_JSON" | jq -r '.files[].path' 2>/dev/null || true)

if [ ${#FORBIDDEN_FILES[@]} -gt 0 ]; then
  echo "ERROR: Forbidden files detected:"
  for file in "${FORBIDDEN_FILES[@]}"; do
    echo "  - $file"
  done
  echo "Forbidden files will be flagged in review findings"
fi

# --- Extract acceptance criteria from linked issue ---
CURRENT_STAGE="extract acceptance criteria"
echo "Extracting acceptance criteria from linked issues..."

ACCEPTANCE_CRITERIA=""
if [ -n "$LINKED_ISSUES" ]; then
  # Extract first issue number
  FIRST_ISSUE=$(echo "$LINKED_ISSUES" | awk '{print $1}' | tr -d '#')

  if [ -n "$FIRST_ISSUE" ]; then
    echo "Fetching linked issue #${FIRST_ISSUE}..."
    ISSUE_JSON=$(gh issue view "${FIRST_ISSUE}" -R "${REPO}" --json body 2>&1 | jq -r '.body // ""' 2>/dev/null || echo "")

    if [ -n "$ISSUE_JSON" ]; then
      # Extract checkbox items as acceptance criteria
      ACCEPTANCE_CRITERIA=$(echo "$ISSUE_JSON" | grep -E '^\s*-\s*\[[\s|x|X]\]' | sed 's/^[[:space:]]*-[[:space:]]*\[[^]]*\][[:space:]]*//g' || echo "")

      if [ -n "$ACCEPTANCE_CRITERIA" ]; then
        echo "Found acceptance criteria:"
        echo "$ACCEPTANCE_CRITERIA" | head -5
      fi
    fi
  fi
fi

# --- Check PR scope (file count and line count) ---
CURRENT_STAGE="check PR scope"
echo "Analyzing PR scope..."

FILES_CHANGED=$(echo "$PR_JSON" | jq '.files | length')
LINES_ADDED=$(echo "$DIFF" | grep -c "^+" || echo "0")
LINES_REMOVED=$(echo "$DIFF" | grep -c "^-" || echo "0")

echo "PR Statistics:"
echo "  Files changed: $FILES_CHANGED"
echo "  Lines added: $LINES_ADDED"
echo "  Lines removed: $LINES_REMOVED"

SCOPE_WARNING=""
if [ "$FILES_CHANGED" -gt 10 ]; then
  SCOPE_WARNING="$SCOPE_WARNING⚠️ Large file count: $FILES_CHANGED files changed (threshold: 10)\n"
fi
if [ "$LINES_ADDED" -gt 1000 ]; then
  SCOPE_WARNING="$SCOPE_WARNING⚠️ Large addition: $LINES_ADDED lines added (threshold: 1000)\n"
fi

if [ -n "$SCOPE_WARNING" ]; then
  echo "Scope warnings detected"
fi

# --- Build the review prompt ---
CURRENT_STAGE="run review analysis"
echo "Starting automated review analysis..."

REVIEW_FINDINGS_FILE="/tmp/review-findings.json"
REVIEW_FINDINGS_SCHEMA="/lib/review-findings.schema.json"

REVIEW_MISSION="You are an automated code review agent for PR #${PR_NUMBER} in ${REPO}.

## PR Details
**Title:** ${PR_TITLE}
**Author:** ${PR_AUTHOR}
**HEAD SHA:** ${HEAD_SHA}
**BASE SHA:** ${BASE_SHA}
**Linked Issues:** ${LINKED_ISSUES:-None identified}

## PR Statistics
- **Files Changed:** ${FILES_CHANGED}
- **Lines Added:** ${LINES_ADDED}
- **Lines Removed:** ${LINES_REMOVED}

## PR Context
${PR_JSON}

## CI Status (Real Data)
${CI_CHECKS}

## Forbidden Files Detected
$(if [ ${#FORBIDDEN_FILES[@]} -gt 0 ]; then echo "The following forbidden files were found in this PR:"; for file in "${FORBIDDEN_FILES[@]}"; do echo "- \`$file\`"; done; else echo "No forbidden files detected (good!)"; fi)

## Acceptance Criteria from Linked Issue
$(if [ -n "$ACCEPTANCE_CRITERIA" ]; then echo "$ACCEPTANCE_CRITERIA" | sed 's/^/- [ ] /g'; else echo "No acceptance criteria found in linked issue(s)"; fi)

## Scope Assessment
$(if [ -n "$SCOPE_WARNING" ]; then echo -e "$SCOPE_WARNING"; else echo "PR scope is within normal limits"; fi)

### How to Interpret CI Status
- If all checks are passing or not yet run: Proceed with code review
- If checks are failing: Determine if failures are in files changed by this PR
  - If YES (failures in changed files): Request changes and explain what's broken
  - If NO (pre-existing failures): Note this but don't block approval
- If CI hasn't completed: Note in your review that CI is still pending

## File Blocklist Rules
AUTO-REJECT PRs containing the following files:
- **Backup files**: \`*.backup\`, \`*.bak\`, \`*.orig\`
- **Credentials**: \`.env\`, \`credentials.*\`, \`*secret*\`, \`*.key\`, \`*.pem\`
- **Package directories**: \`node_modules/\`, \`__pycache__/\`
- **Large files**: Any single file > 500KB
- **Protected paths**: CI/CD workflows, infrastructure code, deployment scripts

If ANY forbidden file is found, set decision to \"changes_requested\" with a summary explaining the file violations.

## Review Criteria
You must evaluate this PR against the following criteria and provide structured findings:

1. **File Blocklist**: Are there forbidden files (backups, credentials, large files)? (REQUIRED)
2. **Compilation/Linting**: Does the code compile and pass basic linting? Factor in CI results.
3. **Security**: Are there any security issues (secret exposure, injection vulnerabilities, unsafe patterns)?
4. **Issue Alignment**: Does this PR actually address the linked issue(s)?
5. **Logic**: Are there obvious logic errors or bugs? Factor in CI results for test failures.
6. **Complexity**: Does it introduce unnecessary complexity or scope creep?
7. **Cost Impact**: Are there concerning cost implications (new infrastructure, expensive dependencies)?
8. **CI Status**: Are there CI failures in changed files? Pre-existing failures should not block approval.
9. **Acceptance Criteria**: If the PR references a linked issue with acceptance criteria checkboxes, verify that the diff addresses each item.
10. **Scope Warning**: Flag if PR touches >10 files or adds >1000 lines (warn but don't reject).

## Your Tasks
1. **Check for forbidden files**: Review the list of forbidden files. If ANY are present, set decision to \"changes_requested\"
2. **Examine the codebase**: Use your tools to read relevant files and understand the changes
3. **Analyze the diff**: Review the actual changes being made
4. **Check acceptance criteria**: If acceptance criteria were listed, review the diff to verify each criterion is addressed
5. **Check scope**: Consider if the PR is too large (>10 files or >1000 lines added). Warn in findings if so, but don't reject based on scope alone
6. **Check for issues**: Look for the problems listed in the review criteria
7. **Make a decision**: Determine if this should be APPROVED or if CHANGES ARE REQUESTED
8. **Document findings**: Return only the structured JSON object as your final response

## Output Format
After completing your review, return exactly this JSON structure as your final response:
\`\`\`json
{
  \"decision\": \"approved\" or \"changes_requested\",
  \"summary\": \"Brief summary of the review\",
  \"findings\": {
    \"forbidden_files\": {
      \"status\": \"pass\" or \"fail\",
      \"details\": \"List of forbidden files found (if any)\"
    },
    \"compilation\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about compilation/linting\"
    },
    \"security\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"issues\": [\"Issue 1\", \"Issue 2\"]
    },
    \"issue_alignment\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about issue alignment and acceptance criteria\"
    },
    \"logic\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"issues\": [\"Logic issue 1\", \"Logic issue 2\"]
    },
    \"complexity\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about complexity\"
    },
    \"cost_impact\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about cost impact\"
    },
    \"scope\": {
      \"status\": \"pass\" or \"warn\" or \"unknown\",
      \"details\": \"Details about PR scope (files changed, lines added)\"
    }
  }
}
\`\`\`

## Working Directory
You are in the PR head worktree (${HEAD_SHA}). The base version is available at ../base-worktree.

## Guidelines
- Be thorough but efficient with your analysis
- Focus on real issues, not style preferences
- If unsure about something critical, request changes rather than approve
- Consider the impact and scope of changes
- Check that tests pass if there are any
- Always provide accurate status values (pass/fail/unknown), not placeholder text
- Provide actual details and issues, not generic \"See full review log\" messages

Begin your review now."

# --- Run Codex with OpenRouter API ---
echo "Running review analysis with Codex on GLM 5.2..."
configure_codex_openrouter review
start_virtual_display

# Change to the PR head worktree for analysis
cd ../pr-worktree
setup_review_dependencies

# Run Codex with the review mission
# Add 30-minute (1800 second) hard timeout to prevent stuck reviews from burning credits
CODEX_EXIT_CODE=0
rm -f "${REVIEW_FINDINGS_FILE}"
env -i \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  HOME="/home/agent" \
  USER="agent" \
  LOGNAME="agent" \
  LANG="C.UTF-8" \
  CI="true" \
  TERM="dumb" \
  DISPLAY="${DISPLAY:-}" \
  CODEX_HOME="${CODEX_HOME}" \
  CODEX_DISABLE_NONESSENTIAL_TRAFFIC="1" \
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY}" \
  timeout 1800 codex exec --ephemeral --skip-git-repo-check \
  --strict-config \
  --ignore-rules \
  --sandbox read-only \
  --output-schema "${REVIEW_FINDINGS_SCHEMA}" \
  --output-last-message "${REVIEW_FINDINGS_FILE}" \
  --model "z-ai/glm-5.2" \
  "${REVIEW_MISSION}" 2>&1 | tee "${REVIEW_LOG}" || CODEX_EXIT_CODE=$?

if [ "${CODEX_EXIT_CODE}" -ne 0 ]; then
  echo "ERROR: Review analysis exited with code ${CODEX_EXIT_CODE}" | tee -a "${REVIEW_LOG}"
  REVIEW_STATUS="error"
  exit "${CODEX_EXIT_CODE}"
fi

if detect_provider_credit_exhaustion "${REVIEW_LOG}"; then
  echo "Detected OpenRouter provider credit exhaustion; stopping review." | tee -a "${REVIEW_LOG}"
  REVIEW_STATUS="error"
  exit 1
fi

# Check if the findings file exists and was written by Codex
if [ ! -f "${REVIEW_FINDINGS_FILE}" ]; then
  echo "ERROR: Review analysis did not write findings file to ${REVIEW_FINDINGS_FILE}"
  REVIEW_STATUS="error"
  exit 1
fi

# Parse the findings JSON file
echo "Parsing review findings from ${REVIEW_FINDINGS_FILE}..."
FINDINGS_DATA=$(cat "${REVIEW_FINDINGS_FILE}")

# Extract decision and key data from the findings
REVIEW_DECISION=$(echo "$FINDINGS_DATA" | jq -r '.decision // "error"')
FINDINGS_SUMMARY=$(echo "$FINDINGS_DATA" | jq -r '.summary // "No summary provided"')

# Validate decision value
if [ "$REVIEW_DECISION" != "approved" ] && [ "$REVIEW_DECISION" != "changes_requested" ]; then
  echo "ERROR: Invalid decision value in findings: $REVIEW_DECISION"
  REVIEW_DECISION="error"
  REVIEW_STATUS="error"
  exit 1
fi

# Create structured findings JSON for upload to S3
FINDINGS_JSON=$(jq -n \
  --arg task_id "${TASK_ID}" \
  --arg pr_number "${PR_NUMBER}" \
  --arg decision "${REVIEW_DECISION}" \
  --argjson findings "$(echo "$FINDINGS_DATA" | jq '.findings')" \
  --arg summary "${FINDINGS_SUMMARY}" \
  --arg completed_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  '{
    task_id: $task_id,
    pr_number: ($pr_number | tonumber),
    decision: $decision,
    findings: $findings,
    summary: $summary,
    completed_at: $completed_at
  }')

echo "=== Review Analysis Complete ==="
echo "Decision: ${REVIEW_DECISION}"
echo "Summary: ${FINDINGS_SUMMARY}"
echo "Full findings:"
echo "$FINDINGS_DATA" | jq '.'

# Update status and post results
update_review_status "completed" "$REVIEW_DECISION" "$FINDINGS_JSON" ""
upload_review_artifacts
apply_review_labels "$REVIEW_DECISION"

# Format findings for the review comment
FORMATTED_FINDINGS=$(format_review_findings "$FINDINGS_DATA")
post_review_comment "$REVIEW_DECISION" "$FORMATTED_FINDINGS"

REVIEW_STATUS="completed"
