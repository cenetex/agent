#!/bin/bash
# Tests for the pre-push shippability gate (agent/lib/verify-outputs.sh).
#
# Regression: verify-outputs pushed the branch and opened a PR before running
# tsc --noEmit, so unbuildable code reached a public PR (issue #422).  The
# gate now runs tsc --noEmit / npm run lint / cargo check / py_compile *before*
# publish_worker_commit and sets RUN_STATUS="failed" + VERIFY_OUTPUTS_FAILURE on
# a type error, without pushing.
#
# Run: bash agent/lib/test_verify_outputs.sh
set -u

PASS=0
FAIL=0
TSC_BIN=""
WORKDIR=""

# Locate a usable tsc (local first, then npx --yes).
resolve_tsc() {
  if [ -x "./node_modules/.bin/tsc" ]; then
    TSC_BIN="./node_modules/.bin/tsc"
  elif command -v tsc >/dev/null 2>&1; then
    TSC_BIN="tsc"
  fi
}

ok()    { PASS=$((PASS + 1)); echo "  ok    $1"; }
notok() { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }

# Stubs for entrypoint globals the gate reads.
IS_PR="false"
TRIGGER_LABEL="agent"
RESOLVED_COMMIT_SHA=""
VERIFY_OUTPUTS_RUN_TESTS="0"
VERIFY_OUTPUTS_OUTPUT_LINES="10"

setup_tmp_repo() {
  WORKDIR="$(mktemp -d)"
  cd "$WORKDIR"
  git init -q
  git config user.email "t@t"
  git config user.name "t"
  git commit --allow-empty -q -m init
  RESOLVED_COMMIT_SHA="$(git rev-parse HEAD)"
}

teardown() {
  cd /work/repo
  [ -n "$WORKDIR" ] && rm -rf "$WORKDIR"
}

# Source the library under test (entrypoint.sh sources it from /lib, but the
# functions only depend on the env stubs above).
. /work/repo/agent/lib/verify-outputs.sh 2>/dev/null \
  || . "$(dirname "$0")/verify-outputs.sh" 2>/dev/null \
  || { echo "ERROR: could not source verify-outputs.sh" >&2; exit 1; }

resolve_tsc

echo "verify-outputs gate:"

# ---------------------------------------------------------------------------
# Case 1: healthy TS repo — gate passes, no VERIFY_OUTPUTS_FAILURE.
# ---------------------------------------------------------------------------
setup_tmp_repo
mkdir -p sub
cat > sub/tsconfig.json <<'TS'
{ "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true } }
TS
cat > sub/index.ts <<'TS'
export const add = (a: number, b: number): number => a + b;
TS
# Need node_modules for the gate to consider the dir "installed".
mkdir -p sub/node_modules
git add -A
git commit -q -m "add ts"

if command -v tsc >/dev/null 2>&1 || [ -n "$TSC_BIN" ]; then
  if VERIFY_OUTPUTS_FAILURE="" verify_outputs_tsjs >/dev/null 2>&1 \
       && [ -z "$VERIFY_OUTPUTS_FAILURE" ]; then
    ok "healthy TS passes the gate"
  else
    notok "healthy TS passes the gate (got: $VERIFY_OUTPUTS_FAILURE)"
  fi
else
  echo "  skip  healthy TS (no tsc available)"
fi
teardown

# ---------------------------------------------------------------------------
# Case 2: TS file with a deliberate type error — gate fails, message set.
# ---------------------------------------------------------------------------
setup_tmp_repo
mkdir -p sub
cat > sub/tsconfig.json <<'TS'
{ "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true } }
TS
cat > sub/index.ts <<'TS'
export const add = (a: number, b: number): number => a + b;
const bad: number = "not a number";
TS
mkdir -p sub/node_modules
git add -A
git commit -q -m "add ts with type error"

if command -v tsc >/dev/null 2>&1 || [ -n "$TSC_BIN" ]; then
  VERIFY_OUTPUTS_FAILURE=""
  if ! verify_outputs_tsjs >/dev/null 2>&1 \
       && [ -n "$VERIFY_OUTPUTS_FAILURE" ] \
       && echo "$VERIFY_OUTPUTS_FAILURE" | grep -qi "bad\|error\|not assignable\|TS"; then
    ok "TS type error fails the gate with a message"
  else
    notok "TS type error fails the gate with a message (got: '$VERIFY_OUTPUTS_FAILURE')"
  fi
else
  echo "  skip  TS type error (no tsc available)"
fi
teardown

# ---------------------------------------------------------------------------
# Case 3: TS syntax error (catch-arrow, the exact #419 regression) — fails.
# ---------------------------------------------------------------------------
setup_tmp_repo
mkdir -p sub
cat > sub/tsconfig.json <<'TS'
{ "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true } }
TS
cat > sub/index.ts <<'TS'
export function fn(): void {
  try {
    doThing();
  } catch ((error: any) => {
    console.error(error);
  })
}
TS
mkdir -p sub/node_modules
git add -A
git commit -q -m "add ts with syntax error"

if command -v tsc >/dev/null 2>&1 || [ -n "$TSC_BIN" ]; then
  VERIFY_OUTPUTS_FAILURE=""
  if ! verify_outputs_tsjs >/dev/null 2>&1 \
       && [ -n "$VERIFY_OUTPUTS_FAILURE" ]; then
    ok "TS syntax error (catch-arrow) fails the gate"
  else
    notok "TS syntax error (catch-arrow) fails the gate (got: '$VERIFY_OUTPUTS_FAILURE')"
  fi
else
  echo "  skip  TS syntax error (no tsc available)"
fi
teardown

# ---------------------------------------------------------------------------
# Case 4: Python syntax error — py_compile catches it.
# ---------------------------------------------------------------------------
setup_tmp_repo
cat > broken.py <<'PY'
def broken(:
    return 1
PY
git add -A
git commit -q -m "add broken py"

VERIFY_OUTPUTS_FAILURE=""
if ! verify_outputs_python >/dev/null 2>&1 \
     && [ -n "$VERIFY_OUTPUTS_FAILURE" ] \
     && echo "$VERIFY_OUTPUTS_FAILURE" | grep -qi "py_compile\|SyntaxError\|broken.py"; then
  ok "Python syntax error fails the gate with a message"
else
  notok "Python syntax error fails the gate with a message (got: '$VERIFY_OUTPUTS_FAILURE')"
fi
teardown

# ---------------------------------------------------------------------------
# Case 5: no applicable language — gate is a no-op (returns 0).
# ---------------------------------------------------------------------------
setup_tmp_repo
cat > README.md <<'MD'
# hello
MD
git add -A
git commit -q -m "add readme"

VERIFY_OUTPUTS_FAILURE=""
if verify_outputs_gate >/dev/null 2>&1 && [ -z "$VERIFY_OUTPUTS_FAILURE" ]; then
  ok "no applicable language is a no-op"
else
  notok "no applicable language is a no-op"
fi
teardown

# ---------------------------------------------------------------------------
# Case 6: PR-review task — gate skipped (IS_PR=true).
# ---------------------------------------------------------------------------
setup_tmp_repo
IS_PR="true"
VERIFY_OUTPUTS_FAILURE=""
if verify_outputs_gate >/dev/null 2>&1; then
  ok "PR-review task skips the gate"
else
  notok "PR-review task skips the gate"
fi
IS_PR="false"
teardown

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
