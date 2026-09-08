#!/bin/bash
# Tests for has_agent_question_comment's matching rule (see common.sh).
#
# Regression: the predicate matched any body containing "?", so the runtime's
# own status comments qualified -- they carry artifact URLs of the form
# ".../?prefix=tasks/...". The call site sets RUN_STATUS="waiting" on a match,
# which froze issues in agent:waiting with no question for anyone to answer
# (#422 since 2026-06-15, #415 since 2026-07-01).
#
# Run: bash agent/lib/test_question_detection.sh
set -u

SINCE="2026-01-01T00:00:00Z"

# Mirrors the jq predicate in has_agent_question_comment.
matches() {
  jq -e --arg since "$SINCE" '
    map(
      select(
        .created_at >= $since
        and (
          (.body | test("<!-- *agent-question *-->"; "i"))
          or (
            (.user.type // "") != "Bot"
            and ((.body | gsub("https?://[^\\s)\"]+"; "")) | test("\\?"))
          )
        )
      )
    )
    | length > 0
  ' >/dev/null 2>&1 <<<"$1" && echo "QUESTION" || echo "not-a-question"
}

pass=0; fail=0
t() {
  local name="$1" want="$2" payload="$3" got
  got=$(matches "$payload")
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); echo "  ok    $name"
  else
    fail=$((fail + 1)); echo "  FAIL  $name (want $want, got $got)"
  fi
}

bot()   { printf '[{"created_at":"2026-06-01T00:00:00Z","user":{"type":"Bot","login":"cenetex[bot]"},"body":%s}]' "$1"; }
human() { printf '[{"created_at":"2026-06-01T00:00:00Z","user":{"type":"User","login":"atimics"},"body":%s}]' "$1"; }

echo "question detection:"
t "bot status comment carrying a ?prefix= artifact URL" "not-a-question" \
  "$(bot '"Agent run failed.\n[View artifacts](https://console.aws.amazon.com/s3/buckets/x?prefix=tasks/cenetex/agent/task_1/)"')"
t "bot comment with no question"                        "not-a-question" \
  "$(bot '"Task dispatched."')"
t "human asking a question"                             "QUESTION" \
  "$(human '"Which model should this use?"')"
t "human comment whose only ? is inside a URL"          "not-a-question" \
  "$(human '"see https://example.com/a?b=c"')"
t "human with a URL and a real question"                "QUESTION" \
  "$(human '"see https://example.com/a?b=c — should I rebase?"')"
t "explicit agent-question marker from a bot"           "QUESTION" \
  "$(bot '"<!-- agent-question -->\nWhich branch is the base?"')"
t "comment predating the run start"                     "not-a-question" \
  '[{"created_at":"2025-01-01T00:00:00Z","user":{"type":"User","login":"atimics"},"body":"anything?"}]'

echo
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
