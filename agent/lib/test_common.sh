#!/bin/bash
# Unit tests for common.sh — run with: bash agent/lib/test_common.sh
#
# These tests cover the question-comment detection regression fixed in #426
# (URL "?" query strings were falsely matched as questions, freezing issues
# in agent:waiting and short-circuiting the retry loop).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

PASS=0
FAIL=0

# Override `gh` so tests don't hit the network. Test cases set MOCK_COMMENTS_JSON
# before calling has_agent_question_comment.
gh() {
  if [ "$1" = "api" ]; then
    printf '%s' "${MOCK_COMMENTS_JSON:-[]}"
    return 0
  fi
  command gh "$@"
}
export -f gh

assert_question_detected() {
  local label="$1"
  if has_agent_question_comment "1" "fake/repo" "2000-01-01T00:00:00Z" 2>/dev/null; then
    PASS=$((PASS + 1))
    echo "  ok: ${label}"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: ${label} (expected question detected, got none)"
  fi
}

assert_no_question() {
  local label="$1"
  if has_agent_question_comment "1" "fake/repo" "2000-01-01T00:00:00Z" 2>/dev/null; then
    FAIL=$((FAIL + 1))
    echo "  FAIL: ${label} (expected no question, but one was detected)"
  else
    PASS=$((PASS + 1))
    echo "  ok: ${label}"
  fi
}

# --- Case 1: bot status comment with artifact URL containing ?prefix=... ---
# This is the regression case from #426. Must NOT be flagged as a question.
MOCK_COMMENTS_JSON='[
  {
    "created_at": "2026-05-06T02:45:54Z",
    "user": {"type": "Bot", "login": "cenetex[bot]"},
    "body": "Agent run failed. [View artifacts](https://console.aws.amazon.com/s3/buckets/foo?prefix=tasks/x/y/)"
  }
]'
assert_no_question "bot URL '?prefix=' is not a question"

# --- Case 2: agent comment with the explicit marker ---
MOCK_COMMENTS_JSON='[
  {
    "created_at": "2026-05-06T02:50:00Z",
    "user": {"type": "Bot", "login": "github-agent[bot]"},
    "body": "<!-- agent-question -->\nShould I use lib-dynamodb or client-dynamodb?"
  }
]'
assert_question_detected "explicit <!-- agent-question --> marker is detected"

# --- Case 3: human comment with a real question (fallback path) ---
MOCK_COMMENTS_JSON='[
  {
    "created_at": "2026-05-06T03:00:00Z",
    "user": {"type": "User", "login": "atimics"},
    "body": "Hey, what bucket should this read from?"
  }
]'
assert_question_detected "human '?' question is detected via fallback"

# --- Case 4: human comment whose only '?' lives in a URL ---
# Must NOT be flagged — the human said "see this dashboard" with a URL but no question.
MOCK_COMMENTS_JSON='[
  {
    "created_at": "2026-05-06T03:05:00Z",
    "user": {"type": "User", "login": "atimics"},
    "body": "see https://example.com/path?x=1 for context"
  }
]'
assert_no_question "human comment with '?' only in URL is not a question"

# --- Case 5: comment older than 'since' is ignored even if it contains a marker ---
MOCK_COMMENTS_JSON='[
  {
    "created_at": "1999-12-31T00:00:00Z",
    "user": {"type": "Bot", "login": "github-agent[bot]"},
    "body": "<!-- agent-question -->\nOld question from a prior run"
  }
]'
assert_no_question "marker comment older than since= is ignored"

# --- Case 6: empty comments array ---
MOCK_COMMENTS_JSON='[]'
assert_no_question "no comments at all is not a question"

# --- Case 7: bot comment with marker (some flows have the bot relay the agent's question) ---
MOCK_COMMENTS_JSON='[
  {
    "created_at": "2026-05-06T02:50:00Z",
    "user": {"type": "Bot", "login": "cenetex[bot]"},
    "body": "Some preamble\n\n<!-- agent-question -->\n\nShould I proceed?"
  }
]'
assert_question_detected "marker anywhere in bot body is detected"

echo
echo "Passed: ${PASS}, Failed: ${FAIL}"
[ "${FAIL}" -eq 0 ]
