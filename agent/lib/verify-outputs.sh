#!/bin/bash
# Pre-push shippability gate for agent-created changes.
#
# Runs the appropriate "is this code shippable" check *before* the branch is
# pushed and the PR is opened.  On failure the caller MUST NOT push — it sets
# RUN_STATUS="failed" and the on_exit handler labels the issue `agent:failed`
# with the offending compiler/lint output in the comment.
#
# Design notes
# ------------
# * The worker sandbox blocks the npm registry, so `npm install` / `npm ci`
#   cannot resolve dependencies.  This gate relies on node_modules already
#   present in the Docker image (installed at build time).  If a tool is
#   missing the gate degrades gracefully to "Unknown" rather than failing.
# * GitHub Actions CI on the pushed PR branch remains the authoritative test
#   gate for tests that are too expensive to run pre-push.  This gate catches
#   the cheap-but-fatal class of errors (tsc / cargo check / ruff / py_compile)
#   that should never reach a public PR.
# * Per-language presets: TypeScript/JavaScript, Python, Rust.  Each is keyed
#   off the manifest files in the working tree (tsconfig.json, *.py, Cargo.toml)
#   so the same entrypoint serves repos of any stack.
#
# Usage (sourced by entrypoint.sh):
#   if ! verify_outputs_gate; then
#       if [ -z "${VERIFY_OUTPUTS_FAILURE:-}" ]; then
#           VERIFY_OUTPUTS_FAILURE="verify-outputs gate reported failure but no message was set"
#       fi
#       RUN_STATUS="failed"
#       break
#   fi
#
# Environment:
#   VERIFY_OUTPUTS_RUN_TESTS (default "0") — when "1" also run `npm test` /
#     `pytest` / `cargo test` if a test script/runner exists.  Tests can be
#   expensive; the flag keeps the default path cheap.
#
# Exports on failure:
#   VERIFY_OUTPUTS_FAILURE — the first ~10 lines of compiler/lint output, for
#     the diagnostic comment posted by the failure handler.

set -Eeuo pipefail

VERIFY_OUTPUTS_RUN_TESTS="${VERIFY_OUTPUTS_RUN_TESTS:-0}"
VERIFY_OUTPUTS_FAILURE="${VERIFY_OUTPUTS_FAILURE:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# detect_npm_dir — the nearest ancestor of the working dir containing a
# package.json whose node_modules also exists (i.e. deps are installed).
verify_outputs_npm_dir() {
  local dir="${WORKDIR:-$(pwd)}"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "${dir}/package.json" ] && [ -d "${dir}/node_modules" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# verify_outputs_trim_output — keep the first ~10 meaningful lines of a tool
# output blob for the diagnostic comment.  Strips progress noise and trailing
# blank lines so the comment is scannable.
verify_outputs_trim_output() {
  local raw="$1"
  local lines="${VERIFY_OUTPUTS_OUTPUT_LINES:-10}"
  printf '%s\n' "$raw" \
    | sed -E '/^[[:space:]]*$/d; /[[:space:]]\.\.\.[[:space:]]*$/d' \
    | head -n "$lines" \
    | sed -E 's/[[:space:]]+$//'
}

# verify_outputs_set_failure — store the trimmed output so the entrypoint can
# include it in the `agent:failed` comment.
verify_outputs_set_failure() {
  local tool="$1"
  local output="$2"
  local trimmed
  trimmed="$(verify_outputs_trim_output "$output" 2>/dev/null || printf '%s\n' "$output")"
  if [ -z "$trimmed" ]; then
    trimmed="${tool} reported a non-zero exit but produced no output."
  fi
  VERIFY_OUTPUTS_FAILURE="${tool} failed:

\`\`\`
${trimmed}
\`\`\`

Re-add the \`${TRIGGER_LABEL}\` label after fixing the error and the agent will retry."
  export VERIFY_OUTPUTS_FAILURE
}

# ---------------------------------------------------------------------------
# TypeScript / JavaScript preset
# ---------------------------------------------------------------------------

# verify_outputs_tsjs — if any tsconfig.json or package.json with a lint script
# is present in the changed paths, run tsc --noEmit and `npm run lint`.
# Returns 0 on success / not-applicable, 1 on failure (and sets
# VERIFY_OUTPUTS_FAILURE).
verify_outputs_tsjs() {
  local npm_dir output rc

  npm_dir="$(verify_outputs_npm_dir 2>/dev/null)" || {
    echo "[verify-outputs] no installed node_modules; TS/JS preset degrades to Unknown" >&2
    return 0
  }

  # --- tsc --noEmit ---
  # Run tsc in the directory containing the nearest tsconfig.json so the
  # project-relative paths it reports match what a human will see in the PR.
  local tsconfig_dir="$npm_dir"
  if [ ! -f "${tsconfig_dir}/tsconfig.json" ]; then
    # No root tsconfig — walk up looking for one under the npm dir's tree.
    local found=""
    while IFS= read -r d; do
      if [ -f "${d}/tsconfig.json" ]; then
        found="$d"
        break
      fi
    done < <(find "${npm_dir}" -maxdepth 3 -name tsconfig.json -not -path "*/node_modules/*" 2>/dev/null)
    if [ -n "$found" ]; then
      tsconfig_dir="$found"
    fi
  fi

  if [ -f "${tsconfig_dir}/tsconfig.json" ]; then
    echo "[verify-outputs] Running tsc --noEmit in ${tsconfig_dir}..."
    output="$(cd "${tsconfig_dir}" && npm exec --no-install -- tsc --noEmit 2>&1)" || rc=$?
    rc="${rc:-0}"
    if [ "$rc" -ne 0 ]; then
      echo "$output" >&2
      verify_outputs_set_failure "tsc --noEmit" "$output"
      return 1
    fi
  fi

  # --- npm run lint (if defined) ---
  if jq -e '.scripts.lint' "${npm_dir}/package.json" >/dev/null 2>&1; then
    echo "[verify-outputs] Running npm run lint in ${npm_dir}..."
    output="$(cd "${npm_dir}" && npm run --silent lint 2>&1)" || rc=$?
    rc="${rc:-0}"
    if [ "$rc" -ne 0 ]; then
      echo "$output" >&2
      verify_outputs_set_failure "npm run lint" "$output"
      return 1
    fi
  fi

  # --- optional test run ---
  if [ "${VERIFY_OUTPUTS_RUN_TESTS}" = "1" ] \
      && jq -e '.scripts.test' "${npm_dir}/package.json" >/dev/null 2>&1; then
    echo "[verify-outputs] Running npm test in ${npm_dir}..."
    output="$(cd "${npm_dir}" && npm run --silent test 2>&1)" || rc=$?
    rc="${rc:-0}"
    if [ "$rc" -ne 0 ]; then
      echo "$output" >&2
      verify_outputs_set_failure "npm test" "$output"
      return 1
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Python preset
# ---------------------------------------------------------------------------

# verify_outputs_python — byte-compile every changed .py file; run ruff if
# available; optionally run pytest.  Returns 0 on success / not-applicable.
verify_outputs_python() {
  local changed_py output rc
  changed_py="$(verify_outputs_changed_files '*.py')" || true

  if [ -z "$changed_py" ]; then
    return 0
  fi

  # --- py_compile (always available) ---
  echo "[verify-outputs] Byte-compiling changed Python files..."
  output="$(python3 -m py_compile ${changed_py} 2>&1)" || rc=$?
  rc="${rc:-0}"
  if [ "$rc" -ne 0 ]; then
    echo "$output" >&2
    verify_outputs_set_failure "py_compile" "$output"
    return 1
  fi

  # --- ruff (if installed) ---
  if command -v ruff >/dev/null 2>&1; then
    echo "[verify-outputs] Running ruff check on changed Python files..."
    output="$(ruff check ${changed_py} 2>&1)" || rc=$?
    rc="${rc:-0}"
    if [ "$rc" -ne 0 ]; then
      echo "$output" >&2
      verify_outputs_set_failure "ruff check" "$output"
      return 1
    fi
  fi

  # --- optional pytest ---
  if [ "${VERIFY_OUTPUTS_RUN_TESTS}" = "1" ] && [ -f "pytest.ini" -o -f "setup.cfg" -o -f "pyproject.toml" ]; then
    if command -v pytest >/dev/null 2>&1; then
      echo "[verify-outputs] Running pytest..."
      output="$(python3 -m pytest -q 2>&1)" || rc=$?
      rc="${rc:-0}"
      if [ "$rc" -ne 0 ]; then
        echo "$output" >&2
        verify_outputs_set_failure "pytest" "$output"
        return 1
      fi
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Rust preset
# ---------------------------------------------------------------------------

# verify_outputs_rust — run `cargo check` if a Cargo.toml is present in the
# changed paths.  Returns 0 on success / not-applicable.
verify_outputs_rust() {
  local cargo_dir output rc
  cargo_dir="$(verify_outputs_find_manifest_upwards Cargo.toml)" || return 0

  if ! command -v cargo >/dev/null 2>&1; then
    echo "[verify-outputs] cargo not installed; Rust preset degrades to Unknown" >&2
    return 0
  fi

  echo "[verify-outputs] Running cargo check in ${cargo_dir}..."
  output="$(cd "${cargo_dir}" && cargo check --quiet 2>&1)" || rc=$?
  rc="${rc:-0}"
  if [ "$rc" -ne 0 ]; then
    echo "$output" >&2
    verify_outputs_set_failure "cargo check" "$output"
    return 1
  fi

  if [ "${VERIFY_OUTPUTS_RUN_TESTS}" = "1" ]; then
    echo "[verify-outputs] Running cargo test in ${cargo_dir}..."
    output="$(cd "${cargo_dir}" && cargo test --quiet 2>&1)" || rc=$?
    rc="${rc:-0}"
    if [ "$rc" -ne 0 ]; then
      echo "$output" >&2
      verify_outputs_set_failure "cargo test" "$output"
      return 1
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Shared path helpers
# ---------------------------------------------------------------------------

# verify_outputs_changed_files — print the changed files matching the given
# glob, relative to RESOLVED_COMMIT_SHA.  Falls back to all tracked files if
# the diff is empty (e.g. shallow clone with no origin/main).
verify_outputs_changed_files() {
  local glob="$1"
  local base="${RESOLVED_COMMIT_SHA:-HEAD}"
  local files
  files="$(git diff --name-only "${base}..HEAD" -- "$glob" 2>/dev/null || true)"
  if [ -z "$files" ]; then
    files="$(git ls-files "$glob" 2>/dev/null || true)"
  fi
  [ -n "$files" ] && printf '%s\n' "$files"
}

# verify_outputs_find_manifest_upwards — walk up from the working dir until a
# manifest file is found; print its directory.  Returns 1 if not found.
verify_outputs_find_manifest_upwards() {
  local manifest="$1"
  local dir="${WORKDIR:-$(pwd)}"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "${dir}/${manifest}" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

# verify_outputs_gate — returns 0 if the working tree is shippable (or the
# applicable tools are unavailable), 1 if a check failed.  On failure,
# VERIFY_OUTPUTS_FAILURE holds the trimmed compiler/lint output for the
# diagnostic comment.
verify_outputs_gate() {
  VERIFY_OUTPUTS_FAILURE=""
  local workdir
  workdir="${WORKDIR:-$(pwd)}"

  # PR-review tasks don't push code changes through this gate.
  if [ "${IS_PR:-false}" = "true" ]; then
    echo "[verify-outputs] PR-review task — skipping shippability gate"
    return 0
  fi

  # No changes since the base — nothing to gate.
  local base="${RESOLVED_COMMIT_SHA:-HEAD}"
  if [ "$(git -C "$workdir" rev-parse --verify HEAD 2>/dev/null)" \
       = "$(git -C "$workdir" rev-parse --verify "${base}" 2>/dev/null)" ] 2>/dev/null; then
    echo "[verify-outputs] HEAD == base (${base}); no changes to gate"
    return 0
  fi

  echo "[verify-outputs] Running pre-push shippability gate..."

  # Per-language presets.  Each is a no-op when the language's manifest / file
  # types are absent from the changed paths, so running all of them in sequence
  # is safe for polyglot repos.
  verify_outputs_tsjs || return 1
  verify_outputs_python || return 1
  verify_outputs_rust || return 1

  echo "[verify-outputs] ✅ All shippability checks passed"
  return 0
}
