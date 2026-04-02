#!/bin/bash
set -Eeuo pipefail

# Source common functions
. /lib/common.sh

# --- Required env vars (passed by Lambda via Fargate overrides) ---
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${OPENROUTER_API_KEY:?Missing OPENROUTER_API_KEY}"
: "${REVIEW_PAYLOAD_S3_KEY:?Missing REVIEW_PAYLOAD_S3_KEY}"
: "${ARTIFACTS_BUCKET:?Missing ARTIFACTS_BUCKET}"
: "${ARTIFACT_PREFIX:?Missing ARTIFACT_PREFIX}"
: "${REPO:?Missing REPO}"
: "${PR_NUMBER:?Missing PR_NUMBER}"
: "${REVIEW_CRITERIA:?Missing REVIEW_CRITERIA}"
: "${AWS_REGION:=us-east-1}"

# --- Fetch and parse review payload from S3 ---
echo "Fetching review payload from S3: ${REVIEW_PAYLOAD_S3_KEY}"
REVIEW_PAYLOAD=$(aws s3 cp "s3://${ARTIFACTS_BUCKET}/${REVIEW_PAYLOAD_S3_KEY}" - --region "${AWS_REGION}" 2>/dev/null) || {
  echo "ERROR: Failed to fetch review payload from S3"
  exit 1
}

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

# S3 artifact keys
METADATA_KEY="${ARTIFACT_PREFIX}/review-metadata.json"
LOG_KEY="${ARTIFACT_PREFIX}/review.log"
RESULT_KEY="${ARTIFACT_PREFIX}/review-result.json"

update_review_status() {
  local status="$1"
  local decision="$2"
  local findings="$3"
  local error_message="$4"
  local completed_timestamp=""

  if [ "$status" != "running" ]; then
    completed_timestamp="\"completed_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\","
  fi

  # Create updated metadata JSON
  local metadata_json
  metadata_json=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "pr_number": ${PR_NUMBER},
  "repo_slug": "${REPO_SLUG}",
  "status": "${status}",
  "decision": $(if [ -n "$decision" ]; then echo "\"$decision\""; else echo "null"; fi),
  "task_arn": "",
  "created_at": "${CREATED_AT}",
  "started_at": "${RUN_STARTED_AT}",
  ${completed_timestamp}
  "error_message": $(if [ -n "$error_message" ]; then echo "\"$error_message\""; else echo "null"; fi)
}
EOF
)

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
    def status_icon: if . == "pass" then "✅" elif . == "fail" then "❌" else "❓" end;

    "### File Safety: \(.findings.file_safety.status | status_icon)\n\(.findings.file_safety.details // "")\n" +
    (if (.findings.file_safety.blocklisted_files | length) > 0 then
      "Blocklisted files:\n" + (.findings.file_safety.blocklisted_files | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Compilation/Linting: \(.findings.compilation.status | status_icon)\n\(.findings.compilation.details // "")\n" +
    "\n### Security: \(.findings.security.status | status_icon)\n" +
    (if (.findings.security.issues | length) > 0 then
      "Issues found:\n" + (.findings.security.issues | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Issue Alignment: \(.findings.issue_alignment.status | status_icon)\n\(.findings.issue_alignment.details // "")\n" +
    (if (.findings.issue_alignment.acceptance_criteria_met | length) > 0 then
      "✅ Criteria met:\n" + (.findings.issue_alignment.acceptance_criteria_met | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    (if (.findings.issue_alignment.acceptance_criteria_missing | length) > 0 then
      "❌ Criteria missing:\n" + (.findings.issue_alignment.acceptance_criteria_missing | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Logic: \(.findings.logic.status | status_icon)\n" +
    (if (.findings.logic.issues | length) > 0 then
      "Issues found:\n" + (.findings.logic.issues | map("- \(.)") | join("\n")) + "\n"
    else "" end) +
    "\n### Complexity: \(.findings.complexity.status | status_icon)\n\(.findings.complexity.details // "")\n" +
    (if (.findings.complexity.scope_warning | length) > 0 then
      "⚠️ Scope Warning:\n\(.findings.complexity.scope_warning)\n"
    else "" end) +
    "\n### Cost Impact: \(.findings.cost_impact.status | status_icon)\n\(.findings.cost_impact.details // "")\n"
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

  # Remove any existing review labels
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:approved" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:changes-requested" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:error" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:human-required" 2>/dev/null || true

  # Apply the appropriate label
  case "$decision" in
    "approved")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:approved" 2>/dev/null || true
      ;;
    "changes_requested")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:changes-requested" 2>/dev/null || true
      ;;
    "error")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:error" 2>/dev/null || true
      ;;
  esac
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
    update_review_status "failed" "error" "" "$error_message"
    upload_review_artifacts
    apply_review_labels "error"
    post_review_comment "error" "Error during ${CURRENT_STAGE}. Exit code: ${exit_code}"

    echo "=== Review failed ==="
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

# Fix git remote URL for authenticated access
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"

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

# Get linked issues from PR body
LINKED_ISSUES=$(echo "$PR_JSON" | jq -r '.body // ""' | grep -oE '#[0-9]+' | sort -u | tr '\n' ' ' || echo "")

# Fetch CI check status
echo "Fetching CI check status..."
CI_CHECKS=$(gh pr checks "${PR_NUMBER}" -R "${REPO}" 2>/dev/null || echo "unavailable")

echo "PR context fetched. Linked issues: ${LINKED_ISSUES:-none}"

# --- Fetch detailed file information ---
echo "Analyzing PR files for size and type..."
PR_FILES=$(gh pr view "${PR_NUMBER}" -R "${REPO}" --json files -q '.files[] | {path: .path, size: .additions, deletions: .deletions}' 2>&1 || echo "[]")

# Count files and total lines changed
FILE_COUNT=$(echo "$PR_JSON" | jq '.files | length')
TOTAL_ADDITIONS=$(echo "$PR_JSON" | jq '[.files[].additions] | add // 0')
TOTAL_DELETIONS=$(echo "$PR_JSON" | jq '[.files[].deletions] | add // 0')
echo "PR has ${FILE_COUNT} files changed, ${TOTAL_ADDITIONS} additions, ${TOTAL_DELETIONS} deletions"

# Fetch acceptance criteria from linked issues
ACCEPTANCE_CRITERIA=""
if [ -n "${LINKED_ISSUES}" ]; then
  echo "Fetching acceptance criteria from linked issues..."
  for ISSUE_NUM in ${LINKED_ISSUES}; do
    # Remove the # prefix if present
    ISSUE_NUM="${ISSUE_NUM#\#}"
    ISSUE_BODY=$(gh issue view "${ISSUE_NUM}" -R "${REPO}" --json body -q '.body' 2>&1 || echo "")
    if [ -n "$ISSUE_BODY" ]; then
      # Extract lines with checkboxes (acceptance criteria)
      CRITERIA=$(echo "$ISSUE_BODY" | grep -E '^\s*-\s+\[[x\s]\]' || echo "")
      if [ -n "$CRITERIA" ]; then
        ACCEPTANCE_CRITERIA="${ACCEPTANCE_CRITERIA}
Issue #${ISSUE_NUM} Acceptance Criteria:
${CRITERIA}
"
      fi
    fi
  done
fi

# --- Build the review prompt ---
CURRENT_STAGE="run review analysis"
echo "Starting automated review analysis..."

REVIEW_FINDINGS_FILE="/tmp/review-findings.json"

REVIEW_MISSION="You are an automated code review agent for PR #${PR_NUMBER} in ${REPO}.

## PR Details
**Title:** ${PR_TITLE}
**Author:** ${PR_AUTHOR}
**HEAD SHA:** ${HEAD_SHA}
**BASE SHA:** ${BASE_SHA}
**Linked Issues:** ${LINKED_ISSUES:-None identified}
**Files Changed:** ${FILE_COUNT}
**Total Additions:** ${TOTAL_ADDITIONS}
**Total Deletions:** ${TOTAL_DELETIONS}

## PR Context
${PR_JSON}

## PR File Information
Files changed: ${FILE_COUNT}
Additions: ${TOTAL_ADDITIONS}
Deletions: ${TOTAL_DELETIONS}

Detailed files:
${PR_FILES}

## Linked Issue Acceptance Criteria
${ACCEPTANCE_CRITERIA:-No acceptance criteria found in linked issues}

## CI Status (Real Data)
${CI_CHECKS}

### How to Interpret CI Status
- If all checks are passing or not yet run: Proceed with code review
- If checks are failing: Determine if failures are in files changed by this PR
  - If YES (failures in changed files): Request changes and explain what's broken
  - If NO (pre-existing failures): Note this but don't block approval
- If CI hasn't completed: Note in your review that CI is still pending

## File Blocklist Check
REJECT immediately if the PR contains ANY of these files:
- Files matching: \`*.backup\`, \`*.bak\`, \`*.orig\`
- Files: \`.env\`, \`credentials.*\`, or any file containing \`secret\` in the name
- Directories: \`node_modules/\`, \`__pycache__/\`, \`.git/\`
- Any single file exceeding 500KB in size
If ANY blocklisted file is found, set decision to "changes_requested" and list all problematic files.

## Acceptance Criteria Alignment Check
For each linked issue, you MUST:
1. Fetch the issue body from GitHub using the linked issue number
2. Extract all acceptance criteria checkboxes (lines with \`- [ ]\` or \`- [x]\`)
3. Verify that each criterion is addressed in the PR diff
4. If criteria are found, evaluate whether the PR actually fulfills them
5. Report which criteria are met and which are missing

## Scope Assessment
Flag (but don't auto-reject) if:
- PR modifies MORE than 10 files, AND
- PR adds MORE than 1000 lines

Include a warning about scope creep in these cases, but approval/rejection is based on other factors.

## Review Criteria
You must evaluate this PR against the following criteria and provide structured findings:

1. **File Safety**: No blocklisted files present (REJECT if any found)
2. **Compilation/Linting**: Does the code compile and pass basic linting? Factor in CI results.
3. **Security**: Are there any security issues (secret exposure, injection vulnerabilities, unsafe patterns)?
4. **Issue Alignment**: Does this PR actually address the linked issue(s) and acceptance criteria?
5. **Logic**: Are there obvious logic errors or bugs? Factor in CI results for test failures.
6. **Complexity**: Does it introduce unnecessary complexity or scope creep?
7. **Cost Impact**: Are there concerning cost implications (new infrastructure, expensive dependencies)?
8. **CI Status**: Are there CI failures in changed files? Pre-existing failures should not block approval.

## Your Tasks
1. **Examine the codebase**: Use your tools to read relevant files and understand the changes
2. **Analyze the diff**: Review the actual changes being made
3. **Check for issues**: Look for the problems listed in the review criteria
4. **Make a decision**: Determine if this should be APPROVED or if CHANGES ARE REQUESTED
5. **Document findings**: Write findings to a structured JSON file

## Output Format
After completing your review, write your findings to a JSON file at: /tmp/review-findings.json

The file must have exactly this structure:
\`\`\`json
{
  \"decision\": \"approved\" or \"changes_requested\",
  \"summary\": \"Brief summary of the review\",
  \"findings\": {
    \"file_safety\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about file blocklist check\",
      \"blocklisted_files\": []
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
      \"details\": \"Details about issue alignment\",
      \"acceptance_criteria_met\": [],
      \"acceptance_criteria_missing\": []
    },
    \"logic\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"issues\": [\"Logic issue 1\", \"Logic issue 2\"]
    },
    \"complexity\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about complexity\",
      \"scope_warning\": \"Warning about large PR if applicable\"
    },
    \"cost_impact\": {
      \"status\": \"pass\" or \"fail\" or \"unknown\",
      \"details\": \"Details about cost impact\"
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
- **CRITICAL**: Check file_safety FIRST - ANY blocklisted file must trigger changes_requested
- **Acceptance Criteria**: If criteria are found, verify each one is addressed in the diff
- **Scope**: If >10 files AND >1000 additions, include a scope warning but don't auto-reject
- Use your tools to inspect files in both ../base-worktree and current directory for detailed analysis

Begin your review now."

# --- Run Claude with OpenRouter API ---
echo "Running review analysis with Claude Opus..."
export ANTHROPIC_BASE_URL="https://openrouter.ai/api/v1"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""

# Change to the PR head worktree for analysis
cd ../pr-worktree

# Run Claude Code with the review mission
# Add 30-minute (1800 second) hard timeout to prevent stuck reviews from burning credits
CLAUDE_EXIT_CODE=0
timeout 1800 claude --dangerously-skip-permissions \
  --model "anthropic/claude-opus-4-6" \
  --print \
  "${REVIEW_MISSION}" 2>&1 | tee "${REVIEW_LOG}" || CLAUDE_EXIT_CODE=$?

# Check if the findings file exists and was written by Claude
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
FINDINGS_JSON=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "pr_number": ${PR_NUMBER},
  "decision": "${REVIEW_DECISION}",
  "findings": $(echo "$FINDINGS_DATA" | jq '.findings'),
  "summary": $(echo "$FINDINGS_DATA" | jq -r '.summary // "No summary"'),
  "completed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)

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