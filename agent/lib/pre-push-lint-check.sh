#!/bin/bash
# Pre-push lint hook wrapper
# This script is called by Claude Code before pushing the PR
# It runs the lint loop and handles unresolved issues

set -Eeuo pipefail

# Source common functions
. "${0%/*}/common.sh"

ISSUE_NUMBER="${1:-}"
REPO="${2:-}"

if [ -z "$ISSUE_NUMBER" ] || [ -z "$REPO" ]; then
  echo "Usage: pre-push-lint-check.sh <issue_number> <repo>" >&2
  exit 1
fi

echo "=== Pre-push lint check ==="
echo "Issue: #$ISSUE_NUMBER"
echo "Repo: $REPO"

# Run the lint loop
run_pre_push_lint_loop "$ISSUE_NUMBER" "$REPO"
LINT_EXIT=$?

# Load telemetry if available
if [ -f "/tmp/lint-telemetry.json" ]; then
  echo "[telemetry] $(cat /tmp/lint-telemetry.json)"
fi

if [ $LINT_EXIT -eq 0 ]; then
  echo "✅ Lint check passed"
  exit 0
else
  echo "⚠️ Lint check has unresolved warnings - pushing anyway with comment"
  exit 0  # Don't fail - still allow push
fi
