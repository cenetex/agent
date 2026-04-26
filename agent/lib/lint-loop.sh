#!/bin/bash
set -Eeuo pipefail

# Pre-push lint loop for agent-created PRs/branches
# Auto-fixes lint violations and retries with LLM if needed
#
# Usage: __lint-loop [optional: llm_client_type]
# Returns: 0 if lint passes or no-op, non-zero if final push should include warning comment

LINT_RETRY_MAX_ATTEMPTS="${LINT_RETRY_MAX_ATTEMPTS:-3}"
LINT_LOOP_TELEMETRY="/tmp/lint-loop-telemetry.json"

# Initialize telemetry
cat > "$LINT_LOOP_TELEMETRY" <<'EOF'
{
  "lint_loop_iterations": 0,
  "lint_loop_outcome": null,
  "lint_loop_errors": []
}
EOF

detect_package_manager() {
  if [ -f "pnpm-lock.yaml" ]; then
    echo "pnpm"
  elif [ -f "yarn.lock" ]; then
    echo "yarn"
  elif [ -f "package-lock.json" ]; then
    echo "npm"
  else
    echo ""
  fi
}

has_lint_script() {
  local pkg_mgr="$(detect_package_manager)"

  if [ -z "$pkg_mgr" ]; then
    return 1
  fi

  # Check if package.json has a lint script
  if [ -f "package.json" ]; then
    jq -e '.scripts.lint' package.json >/dev/null 2>&1
    return $?
  fi

  return 1
}

get_changed_files() {
  # Get files changed on this branch relative to origin/main
  # Only include TypeScript/JavaScript files
  git diff --name-only origin/main..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null || echo ""
}

run_lint_fix() {
  local pkg_mgr="$1"
  local changed_files="$2"

  if [ -z "$changed_files" ]; then
    return 0
  fi

  echo "[lint-loop] Running auto-fix pass on changed files..."

  case "$pkg_mgr" in
    pnpm)
      pnpm exec eslint --fix --max-warnings 0 $changed_files 2>&1
      ;;
    yarn)
      yarn eslint --fix --max-warnings 0 $changed_files 2>&1
      ;;
    npm)
      npm exec eslint -- --fix --max-warnings 0 $changed_files 2>&1
      ;;
  esac

  return $?
}

run_lint_check() {
  local pkg_mgr="$1"
  local changed_files="$2"

  if [ -z "$changed_files" ]; then
    return 0
  fi

  case "$pkg_mgr" in
    pnpm)
      pnpm exec eslint --max-warnings 0 $changed_files 2>&1
      ;;
    yarn)
      yarn eslint --max-warnings 0 $changed_files 2>&1
      ;;
    npm)
      npm exec eslint -- --max-warnings 0 $changed_files 2>&1
      ;;
  esac

  return $?
}

llm_fix_lint_errors() {
  local lint_output="$1"
  local attempt="$2"
  local changed_files="$3"

  echo "[lint-loop] Calling LLM to fix lint errors (attempt $attempt/$LINT_RETRY_MAX_ATTEMPTS)..."

  # Pass lint output to Claude Code via stdin or environment
  # This should be called from within a Claude Code session
  # For now, we'll just log that this would happen

  # The actual fix should be done by Claude Code reading the lint output
  # and making code changes to fix the issues

  # Return non-zero to indicate LLM was needed
  return 1
}

lint_loop_main() {
  local attempt=0
  local pkg_mgr

  # Check if repo has a lint setup
  if ! has_lint_script; then
    echo "[lint-loop] No lint script found in package.json, skipping lint loop"
    jq '.lint_loop_outcome = "no_op"' "$LINT_LOOP_TELEMETRY" > "$LINT_LOOP_TELEMETRY.tmp"
    mv "$LINT_LOOP_TELEMETRY.tmp" "$LINT_LOOP_TELEMETRY"
    return 0
  fi

  pkg_mgr="$(detect_package_manager)"
  echo "[lint-loop] Detected package manager: $pkg_mgr"

  while [ $attempt -lt "$LINT_RETRY_MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))

    # Get changed files on this branch
    local changed_files="$(get_changed_files)"

    if [ -z "$changed_files" ]; then
      echo "[lint-loop] No changed files to lint"
      jq '.lint_loop_outcome = "no_changes" | .lint_loop_iterations = '$attempt "$LINT_LOOP_TELEMETRY" > "$LINT_LOOP_TELEMETRY.tmp"
      mv "$LINT_LOOP_TELEMETRY.tmp" "$LINT_LOOP_TELEMETRY"
      return 0
    fi

    echo "[lint-loop] [Attempt $attempt/$LINT_RETRY_MAX_ATTEMPTS] Linting changed files..."

    if [ $attempt -eq 1 ]; then
      # First attempt: auto-fix pass
      echo "[lint-loop] Running eslint --fix on: $changed_files"

      if run_lint_fix "$pkg_mgr" "$changed_files"; then
        echo "[lint-loop] ✅ Auto-fix resolved all lint issues"
        jq '.lint_loop_outcome = "auto_fixed" | .lint_loop_iterations = '$attempt "$LINT_LOOP_TELEMETRY" > "$LINT_LOOP_TELEMETRY.tmp"
        mv "$LINT_LOOP_TELEMETRY.tmp" "$LINT_LOOP_TELEMETRY"

        # Stage the auto-fixed changes
        git add -u
        return 0
      fi
    fi

    # Check if lint passes now
    if run_lint_check "$pkg_mgr" "$changed_files" >/dev/null 2>&1; then
      echo "[lint-loop] ✅ Lint check passed"
      jq '.lint_loop_outcome = "llm_fixed" | .lint_loop_iterations = '$attempt "$LINT_LOOP_TELEMETRY" > "$LINT_LOOP_TELEMETRY.tmp"
      mv "$LINT_LOOP_TELEMETRY.tmp" "$LINT_LOOP_TELEMETRY"
      return 0
    fi

    # Lint still failing - if we have more attempts, ask LLM to fix
    if [ $attempt -lt "$LINT_RETRY_MAX_ATTEMPTS" ]; then
      echo "[lint-loop] ⚠️ Lint still has issues, need LLM fix"

      # Capture lint output for LLM
      local lint_output
      lint_output="$(run_lint_check "$pkg_mgr" "$changed_files" 2>&1 || true)"

      # Signal that LLM needs to fix this
      echo "[lint-loop] Requesting LLM lint fix (attempt $attempt of $LINT_RETRY_MAX_ATTEMPTS)"
      echo "Lint errors:"
      echo "$lint_output"
      echo ""
      echo "[lint-loop] The agent will now attempt to fix these lint errors..."

      # Create a marker file that Claude will detect to know it should fix lint
      echo "$lint_output" > /tmp/lint-errors-to-fix.txt

      # Return non-zero to signal need for LLM intervention
      return 1
    fi
  done

  # Max attempts reached, lint still failing
  echo "[lint-loop] ❌ Lint check failed after $LINT_RETRY_MAX_ATTEMPTS attempts"

  # Capture final lint output for PR comment
  local final_lint_output
  final_lint_output="$(run_lint_check "$pkg_mgr" "$changed_files" 2>&1 || true)"
  echo "$final_lint_output" > /tmp/unresolved-lint-warnings.txt

  jq '.lint_loop_outcome = "pushed_with_warnings" | .lint_loop_iterations = '$attempt "$LINT_LOOP_TELEMETRY" > "$LINT_LOOP_TELEMETRY.tmp"
  mv "$LINT_LOOP_TELEMETRY.tmp" "$LINT_LOOP_TELEMETRY"

  return 1
}

# Run the lint loop
lint_loop_main "$@"
