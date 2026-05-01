#!/bin/bash
set -Eeuo pipefail

# Orchestrate the lint loop within the agent's worktree
# This script is called by Claude Code as part of the PR finalization step
#
# It manages:
# 1. Running auto-fix passes
# 2. Detecting when LLM intervention is needed
# 3. Tracking telemetry
# 4. Creating PR comments for unresolved warnings

REPO_DIR="${REPO_DIR:-.}"
LINT_RETRY_MAX_ATTEMPTS="${LINT_RETRY_MAX_ATTEMPTS:-3}"

# Source common functions if available
if [ -f "/lib/common.sh" ]; then
  . /lib/common.sh
elif [ -f "$REPO_DIR/../lib/common.sh" ]; then
  . "$REPO_DIR/../lib/common.sh"
fi

# Load telemetry file
TELEMETRY_FILE="/tmp/lint-loop-telemetry.json"

update_telemetry() {
  local key="$1"
  local value="$2"

  if [ -f "$TELEMETRY_FILE" ]; then
    jq ".${key} = ${value}" "$TELEMETRY_FILE" > "$TELEMETRY_FILE.tmp"
    mv "$TELEMETRY_FILE.tmp" "$TELEMETRY_FILE"
  fi
}

log_telemetry_event() {
  local event="$1"

  if [ -f "$TELEMETRY_FILE" ]; then
    jq ".lint_loop_errors += [\"$event\"]" "$TELEMETRY_FILE" > "$TELEMETRY_FILE.tmp"
    mv "$TELEMETRY_FILE.tmp" "$TELEMETRY_FILE"
  fi
}

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
  if [ -f "package.json" ]; then
    jq -e '.scripts.lint' package.json >/dev/null 2>&1
    return $?
  fi
  return 1
}

get_changed_files() {
  git diff --name-only origin/main..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' 2>/dev/null || echo ""
}

run_lint_auto_fix() {
  local pkg_mgr="$1"
  local changed_files="$2"

  if [ -z "$changed_files" ]; then
    return 0
  fi

  echo "[lint] Running eslint --fix on changed files..."
  echo "Files: $changed_files"

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

orchestrate_lint_loop() {
  echo "=== Starting Pre-Push Lint Loop ==="

  # Initialize telemetry
  cat > "$TELEMETRY_FILE" <<'EOF'
{
  "lint_loop_iterations": 0,
  "lint_loop_outcome": null,
  "lint_loop_errors": []
}
EOF

  # Check if repo has lint setup
  if ! has_lint_script; then
    echo "[lint] No lint script in package.json, skipping lint loop"
    update_telemetry 'lint_loop_outcome' '"no_op"'
    return 0
  fi

  local pkg_mgr="$(detect_package_manager)"
  if [ -z "$pkg_mgr" ]; then
    echo "[lint] No package manager detected, skipping lint loop"
    update_telemetry 'lint_loop_outcome' '"no_op"'
    return 0
  fi

  echo "[lint] Detected package manager: $pkg_mgr"

  local attempt=0
  local lint_passed=false

  while [ $attempt -lt "$LINT_RETRY_MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    update_telemetry 'lint_loop_iterations' "$attempt"

    echo "[lint] [Attempt $attempt/$LINT_RETRY_MAX_ATTEMPTS]"

    local changed_files="$(get_changed_files)"
    if [ -z "$changed_files" ]; then
      echo "[lint] No changed files, done"
      lint_passed=true
      break
    fi

    if [ $attempt -eq 1 ]; then
      # First attempt: auto-fix
      echo "[lint] Running auto-fix pass..."
      if run_lint_auto_fix "$pkg_mgr" "$changed_files" >/dev/null 2>&1; then
        echo "[lint] ✅ Auto-fix passed, checking for any remaining issues..."
        # Even after auto-fix, run check to see if it fixed everything
        if run_lint_check "$pkg_mgr" "$changed_files" >/dev/null 2>&1; then
          echo "[lint] ✅ All lint issues resolved by auto-fix"
          git add -u  # Stage the auto-fixed changes
          lint_passed=true
          update_telemetry 'lint_loop_outcome' '"auto_fixed"'
          break
        else
          echo "[lint] ⚠️ Auto-fix made changes but issues still remain"
          git add -u  # Stage the auto-fixed changes for LLM to build upon
        fi
      else
        # Auto-fix may have made changes, let's check lint status
        echo "[lint] Auto-fix completed (with or without changes)"
        if run_lint_check "$pkg_mgr" "$changed_files" >/dev/null 2>&1; then
          echo "[lint] ✅ Lint passed after auto-fix"
          git add -u
          lint_passed=true
          update_telemetry 'lint_loop_outcome' '"auto_fixed"'
          break
        else
          echo "[lint] ⚠️ Lint still failing, need LLM intervention"
          git add -u
        fi
      fi
    else
      # Subsequent attempts: just check lint status (LLM should have fixed code)
      if run_lint_check "$pkg_mgr" "$changed_files" >/dev/null 2>&1; then
        echo "[lint] ✅ Lint passed on attempt $attempt"
        lint_passed=true
        update_telemetry 'lint_loop_outcome' '"llm_fixed"'
        break
      else
        echo "[lint] ⚠️ Lint still failing on attempt $attempt, need more LLM fixes"
      fi
    fi

    if [ $attempt -lt "$LINT_RETRY_MAX_ATTEMPTS" ] && [ "$lint_passed" = false ]; then
      # Capture lint errors for LLM to see
      echo "[lint] Capturing lint output for LLM intervention..."
      local lint_output
      lint_output="$(run_lint_check "$pkg_mgr" "$changed_files" 2>&1 || true)"

      cat > /tmp/lint-errors.txt <<EOF
# Lint Errors (Attempt $attempt)

The following eslint errors need to be fixed:

\`\`\`
$lint_output
\`\`\`

Please analyze these errors and fix the issues in \$changed_files.
After fixing, the code will go through another lint check.
EOF

      echo "[lint] Lint errors saved to /tmp/lint-errors.txt"
      echo "[lint] Agent will now attempt to fix these errors..."

      # Return to signal that LLM should fix these errors
      return 1
    fi
  done

  if [ "$lint_passed" = true ]; then
    echo "[lint] ✅ Lint loop completed successfully"
    return 0
  fi

  # Max attempts reached with lint still failing
  echo "[lint] ❌ Lint check failed after $LINT_RETRY_MAX_ATTEMPTS attempts"

  # Capture final lint output for PR comment
  local changed_files="$(get_changed_files)"
  if [ -n "$changed_files" ]; then
    local final_lint_output
    final_lint_output="$(run_lint_check "$pkg_mgr" "$changed_files" 2>&1 || true)"

    cat > /tmp/unresolved-lint-warnings.txt <<EOF
## Unresolved Lint Warnings

The following lint issues could not be auto-resolved after $LINT_RETRY_MAX_ATTEMPTS attempts:

\`\`\`
$final_lint_output
\`\`\`

These warnings should be addressed before merging.
EOF
  fi

  update_telemetry 'lint_loop_outcome' '"pushed_with_warnings"'
  return 1
}

# Run the orchestration
orchestrate_lint_loop "$@"
