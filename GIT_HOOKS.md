# Git Hooks and Pre-Flight Validation

This document describes the git hooks and pre-flight validation system to prevent pushing code with CI/lint errors.

## Overview

The git hooks system is designed to catch errors **before** they are pushed to the repository. This prevents the agent from pushing code that would fail CI checks in GitHub Actions.

## Components

### 1. Pre-Commit Hook (`.husky/pre-commit`)

Runs **before each commit** to catch errors early in the development cycle.

**Checks:**
- TypeScript compilation in `infra/` - ensures no type errors
- Shell script syntax validation - prevents broken bash scripts

**When it runs:**
- During local development: `git commit`
- In the agent container: During Claude Code execution before commits

**Example:**
```bash
$ git commit -m "Fix webhook handler"
[pre-commit] Running TypeScript type checks...
[pre-commit] Checking shell scripts...
✅ [pre-commit] All checks passed
[main abc1234] Fix webhook handler
```

### 2. Pre-Push Hook (`.husky/pre-push`)

Runs **before pushing to remote** to prevent broken code from reaching the repository.

**Checks:**
- Main branch protection - prevents direct pushes to main
- TypeScript compilation in `infra/`
- GitHub Actions workflow validation - ensures valid YAML

**When it runs:**
- During local development: `git push`
- In the agent container: During Claude Code execution before pushing branches

**Example:**
```bash
$ git push origin feature/new-handler
[pre-push] Running pre-push validation checks...
[pre-push] Building infra TypeScript...
[pre-push] Validating GitHub workflow files...
✅ [pre-push] All pre-push checks passed
```

### 3. Agent Hook Setup

When the agent container starts, it automatically configures git hooks:

**In `agent/entrypoint.sh`:**
```bash
# Install git hooks (pre-commit, pre-push)
git config core.hooksPath .husky || true
chmod +x .husky/pre-commit .husky/pre-push
```

This ensures:
- Hooks are executable
- Git is configured to use the `.husky` directory for hooks
- Checks run before agent pushes code

### 4. Root Package Installation

The root `package.json` now includes husky:

```json
{
  "scripts": {
    "prepare": "husky install"
  },
  "devDependencies": {
    "husky": "^9.0.0"
  }
}
```

**In `deploy.sh`:** Husky hooks are installed during deployment setup.

## Workflow

### For Developers (Local Work)

1. **Clone repository**
   ```bash
   git clone https://github.com/cenetex/agent.git
   cd agent
   npm install  # Installs husky hooks automatically
   ```

2. **Make changes**
   ```bash
   # Edit files
   git add .
   git commit -m "Description"  # Pre-commit hook runs
   ```

3. **Push changes**
   ```bash
   git push origin feature-branch  # Pre-push hook runs
   ```

If any check fails, the commit/push is blocked and you'll see an error message.

### For the Agent (Claude Code Execution)

1. **Repository is cloned** in Fargate container
2. **Hooks are configured** automatically by entrypoint.sh
3. **Agent makes changes** and commits
   - Pre-commit hook validates TypeScript and shell scripts
   - If checks fail, commit is rejected
   - Agent receives error and can fix issues
4. **Agent pushes changes**
   - Pre-push hook validates branch and TypeScript
   - If checks fail, push is rejected
   - Agent cannot push to main directly

## Error Handling

### Pre-Commit Failures

If a pre-commit hook fails:
```
❌ [pre-commit] TypeScript compilation errors in infra/
tsc exited with error code 2
```

**Action required:**
- Fix the TypeScript errors
- Stage the fixed files
- Try committing again

### Pre-Push Failures

If a pre-push hook fails:
```
❌ [pre-push] Direct push to main is not allowed. Create a feature branch and PR instead.
```

**Action required:**
- Create a feature branch
- Push to the feature branch instead
- Create a pull request

## Extending the Hooks

To add more checks:

1. **Add to pre-commit hook** for fast, synchronous checks:
   ```bash
   echo "[pre-commit] Running custom check..."
   if ! command_to_validate; then
     echo "❌ [pre-commit] Custom check failed"
     exit 1
   fi
   ```

2. **Add to pre-push hook** for slower, integration checks:
   ```bash
   echo "[pre-push] Running integration test..."
   if ! npm test; then
     echo "❌ [pre-push] Integration test failed"
     exit 1
   fi
   ```

## Skipping Hooks (Emergency Only)

If you absolutely must skip hooks (not recommended):

```bash
git commit --no-verify  # Skips pre-commit hook
git push --no-verify   # Skips pre-push hook
```

**Warning:** This defeats the purpose of the safety checks. Only use in emergencies.

## Testing the Hooks

### Test Pre-Commit Locally

```bash
# Make a change with a TypeScript error
echo "const x: string = 123;" >> infra/lib/test.ts

# Try to commit
git add infra/lib/test.ts
git commit -m "Test commit"

# Hook should block the commit
# Output: ❌ [pre-commit] TypeScript compilation errors in infra/

# Fix the file and try again
rm infra/lib/test.ts
git reset infra/lib/test.ts
git commit -m "Test commit"
```

### Test Pre-Push Locally

```bash
# Try to push to main (it will be rejected)
git push origin main

# Output: ❌ [pre-push] Direct push to main is not allowed...

# Create a branch and push instead
git checkout -b test-branch
git push origin test-branch  # Should succeed
```

## Integration with CI/CD

These hooks are **in addition to** GitHub Actions CI checks:

- Hooks: Catch errors locally **before** pushing (fast feedback)
- GitHub Actions: Final validation after push (comprehensive testing)

Together they provide defense-in-depth:

```
Developer creates commit
         ↓
    Pre-commit hook (TypeScript, shell)
         ↓
  Developer pushes branch
         ↓
    Pre-push hook (branch protection, validation)
         ↓
     Push successful
         ↓
  GitHub Actions CI
         ↓
   PR created
         ↓
  Code review & merge
```

## References

- **Husky:** https://typicode.github.io/husky/
- **Git Hooks:** https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks
- **Agent Setup:** `agent/entrypoint.sh` (lines ~450-465)
