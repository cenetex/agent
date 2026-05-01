#!/bin/bash
# Quick sanity test for lint-loop implementation

set -e

echo "=== Lint Loop Implementation Test ==="

# Check that files exist
echo "Checking files..."
test -f /work/repo/agent/lib/orchestrate-lint.sh || { echo "ERROR: orchestrate-lint.sh not found"; exit 1; }
test -f /work/repo/agent/lib/lint-loop.sh || { echo "ERROR: lint-loop.sh not found"; exit 1; }
test -x /work/repo/agent/lib/orchestrate-lint.sh || { echo "ERROR: orchestrate-lint.sh not executable"; exit 1; }
test -x /work/repo/agent/lib/lint-loop.sh || { echo "ERROR: lint-loop.sh not executable"; exit 1; }
echo "✅ All lint loop files exist and are executable"

# Check that Dockerfiles were updated
echo "Checking Dockerfiles..."
grep -q "orchestrate-lint.sh" /work/repo/agent/Dockerfile || { echo "ERROR: Dockerfile not updated"; exit 1; }
grep -q "orchestrate-lint.sh" /work/repo/agent/Dockerfile.base || { echo "ERROR: Dockerfile.base not updated"; exit 1; }
grep -q "orchestrate-lint.sh" /work/repo/agent/Dockerfile.review || { echo "ERROR: Dockerfile.review not updated"; exit 1; }
echo "✅ All Dockerfiles updated"

# Check that entrypoint.sh has lint-loop instructions
echo "Checking entrypoint.sh..."
grep -q "Lint Loop Instructions" /work/repo/agent/entrypoint.sh || { echo "ERROR: Lint Loop Instructions not in entrypoint.sh"; exit 1; }
grep -q "orchestrate-lint.sh" /work/repo/agent/entrypoint.sh || { echo "ERROR: orchestrate-lint.sh reference not in entrypoint.sh"; exit 1; }
grep -q "LINT_RETRY_MAX_ATTEMPTS" /work/repo/agent/entrypoint.sh || { echo "ERROR: LINT_RETRY_MAX_ATTEMPTS not in entrypoint.sh"; exit 1; }
echo "✅ entrypoint.sh properly updated"

# Check that telemetry upload is in place
echo "Checking telemetry..."
grep -q "lint-loop-telemetry.json" /work/repo/agent/entrypoint.sh || { echo "ERROR: lint-loop telemetry upload not found"; exit 1; }
echo "✅ Telemetry upload configured"

# Test orchestrate-lint.sh for basic syntax
echo "Testing orchestrate-lint.sh syntax..."
bash -n /work/repo/agent/lib/orchestrate-lint.sh || { echo "ERROR: orchestrate-lint.sh syntax error"; exit 1; }
echo "✅ orchestrate-lint.sh syntax valid"

# Test lint-loop.sh for basic syntax
echo "Testing lint-loop.sh syntax..."
bash -n /work/repo/agent/lib/lint-loop.sh || { echo "ERROR: lint-loop.sh syntax error"; exit 1; }
echo "✅ lint-loop.sh syntax valid"

echo ""
echo "=== All sanity checks passed ==="
echo ""
echo "Implementation includes:"
echo "- Pre-push lint loop with auto-fix pass (eslint --fix)"
echo "- Up to 3 LLM-driven fix attempts"
echo "- Detection of package manager (npm/pnpm/yarn)"
echo "- Linting only changed files relative to origin/main"
echo "- Telemetry logging (lint_loop_iterations, lint_loop_outcome)"
echo "- Proper error handling and fallback to push-with-warnings"
