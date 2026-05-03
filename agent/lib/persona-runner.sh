#!/bin/bash
#
# persona-runner.sh — execute a persona-typed agent dispatch
#
# Called by entrypoint.sh when TASK_PAYLOAD.persona_id is set. Loads the
# persona's YAML profile + MD prompt from /agents/, runs Claude Code with
# the persona's tool allowlist, and posts the resulting review as a comment
# on the persona's target issue.
#
# Inputs (env, set by entrypoint.sh):
#   PERSONA_ID                  — persona identifier (e.g., cab-marcus)
#   TASK_PAYLOAD                — JSON task payload (full)
#   TASK_ID                     — task ID for the dispatch
#   ISSUE_NUMBER                — number of the trigger issue
#   REPO                        — owner/repo of the trigger issue
#   AGENT_LOG                   — path to agent execution log
#   GITHUB_TOKEN                — installation token (gh auth)
#   OPENROUTER_API_KEY          — model inference key
#   ARTIFACTS_BUCKET            — S3 bucket for task artifacts
#   ARTIFACT_PREFIX             — S3 key prefix
#
# Output:
#   Posts comment to <target_repo>#<target_issue> per the persona's YAML.
#   Writes claude output to AGENT_LOG.
#   Sets RUN_STATUS to "succeeded" or "failed" via stdout marker.
#
# Exit code:
#   0  — persona run completed and comment posted
#   1  — persona profile not found
#   2  — claude run failed
#   3  — comment post failed

set -Eeuo pipefail

PERSONA_ID="${PERSONA_ID:?Missing PERSONA_ID}"
TASK_PAYLOAD="${TASK_PAYLOAD:?Missing TASK_PAYLOAD}"
TASK_ID="${TASK_ID:?Missing TASK_ID}"
ISSUE_NUMBER="${ISSUE_NUMBER:?Missing ISSUE_NUMBER}"
REPO="${REPO:?Missing REPO}"
AGENT_LOG="${AGENT_LOG:-/tmp/agent-output.log}"

echo "=== Persona Runner ==="
echo "Persona: ${PERSONA_ID}"
echo "Trigger issue: ${REPO}#${ISSUE_NUMBER}"

# --- Locate persona profile ---
# YAML lives at /agents/<board>/<id>.yaml; the board prefix is part of the id
# but we don't bake the directory layout into the call site — just glob.
PERSONA_YAML=$(find /agents -type f -name "${PERSONA_ID}.yaml" 2>/dev/null | head -1)
if [ -z "${PERSONA_YAML}" ]; then
  echo "ERROR: persona profile not found for id='${PERSONA_ID}'" >&2
  echo "  Searched /agents/**/${PERSONA_ID}.yaml" >&2
  echo "  Available personas:" >&2
  find /agents -type f -name '*.yaml' -printf '    %p\n' >&2 || true
  exit 1
fi
echo "Profile: ${PERSONA_YAML}"

PERSONA_DIR=$(dirname "${PERSONA_YAML}")

# --- Parse persona profile ---
PROMPT_FILE=$(yq -r '.prompt_file' "${PERSONA_YAML}")
DISPLAY_NAME=$(yq -r '.display_name // .id' "${PERSONA_YAML}")
TARGET_REPO=$(yq -r '.output.target_repo' "${PERSONA_YAML}")
TARGET_ISSUE=$(yq -r '.output.target_issue' "${PERSONA_YAML}")
PERSONA_PROMPT_PATH="${PERSONA_DIR}/${PROMPT_FILE}"

if [ ! -f "${PERSONA_PROMPT_PATH}" ]; then
  echo "ERROR: prompt file '${PROMPT_FILE}' not found at ${PERSONA_PROMPT_PATH}" >&2
  exit 1
fi

# --- Build the allowed-tools list ---
# Convention: persona YAML lists tool names with `true` enabled; we map to
# Claude Code's --allowedTools format. Tools not in the YAML map are denied.
declare -a CLAUDE_TOOLS=()
for tool in Bash Read Grep Glob Edit Write; do
  lower=$(echo "${tool}" | tr '[:upper:]' '[:lower:]')
  enabled=$(yq -r ".tools.${lower} // false" "${PERSONA_YAML}")
  if [ "${enabled}" = "true" ]; then
    CLAUDE_TOOLS+=("${tool}")
  fi
done

# Always allow WebFetch for personas (they may need to read external docs)
# but not for board members (commercial separation of concerns).
BOARD=$(yq -r '.board // ""' "${PERSONA_YAML}")
if [ "${BOARD}" != "board" ]; then
  CLAUDE_TOOLS+=("WebFetch")
fi

ALLOWED_TOOLS_FLAG=""
if [ "${#CLAUDE_TOOLS[@]}" -gt 0 ]; then
  ALLOWED_TOOLS_FLAG="--allowedTools $(IFS=,; echo "${CLAUDE_TOOLS[*]}")"
fi

echo "Display name: ${DISPLAY_NAME}"
echo "Target: ${TARGET_REPO}#${TARGET_ISSUE}"
echo "Allowed tools: ${CLAUDE_TOOLS[*]}"

# --- Build mission prompt ---
# The persona MD file is the system prompt. We append a small task-context
# preamble identifying the dispatch (date, trigger issue) so the persona has
# concrete week-ending context.
TODAY_UTC=$(date -u +"%Y-%m-%d")
PERSONA_PROMPT_BODY=$(cat "${PERSONA_PROMPT_PATH}")

MISSION=$(cat <<EOF
${PERSONA_PROMPT_BODY}

---
## This dispatch
- Today (UTC): ${TODAY_UTC}
- Triggered by: ${REPO}#${ISSUE_NUMBER}
- Task ID: ${TASK_ID}
- Persona: ${DISPLAY_NAME} (${PERSONA_ID})
- Output target: ${TARGET_REPO}#${TARGET_ISSUE}

When you finish, post your review as a comment on ${TARGET_REPO}#${TARGET_ISSUE}
using \`gh issue comment ${TARGET_ISSUE} --repo ${TARGET_REPO} --body-file <path>\`.

Sign off with the persona name in the comment heading exactly as your prompt
specifies. Do not post on the trigger issue (${REPO}#${ISSUE_NUMBER}); the
trigger issue is closed automatically by entrypoint.sh once your run completes.
EOF
)

# --- Run Claude Code ---
MODEL=$(echo "${TASK_PAYLOAD}" | jq -r '.model // "anthropic/claude-sonnet-4-6"')
echo "Using model: ${MODEL}"

CLAUDE_EXIT_CODE=0
TIMEOUT_SECONDS=2700  # 45 minutes — same as default flow
echo "=== Starting persona Claude Code run ==="
# shellcheck disable=SC2086
timeout ${TIMEOUT_SECONDS} claude --dangerously-skip-permissions \
    --model "${MODEL}" \
    --effort max \
    --print \
    ${ALLOWED_TOOLS_FLAG} \
    "${MISSION}" 2>&1 | tee "${AGENT_LOG}" || CLAUDE_EXIT_CODE=$?
CLAUDE_EXIT_CODE=${CLAUDE_EXIT_CODE:-${PIPESTATUS[0]}}

if [ "${CLAUDE_EXIT_CODE}" -ne 0 ]; then
  echo "ERROR: persona claude run failed (exit ${CLAUDE_EXIT_CODE})" >&2
  exit 2
fi

# Note: the persona is responsible for posting its own comment via gh from
# inside the claude run. We do NOT post the raw transcript here — the persona
# composes its review using the prompt's required format.
#
# We trust the prompt-enforced format. If the persona doesn't post (silently
# fails), the trigger issue will reflect agent:failed and we'll see it in
# the next CAB review.

echo "=== Persona run complete ==="
echo "Persona: ${PERSONA_ID}"
echo "Posted to: ${TARGET_REPO}#${TARGET_ISSUE}"
exit 0
