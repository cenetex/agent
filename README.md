# GitHub Agent

Autonomous AI agent that automatically implements features, fixes bugs, and reviews code on GitHub. Built on a custom headless executor, Codex review runner, and AWS Fargate.

## Quick Start

To trigger the agent on an issue or PR:
1. Add the `agent` label to any issue or PR
2. The agent will automatically remove the `agent` label and add `agent:running`
3. When complete, the agent will create a PR (for issues) or comment (for PRs)
4. Final status will be shown with `agent:succeeded` or `agent:failed`

## Architecture

The agent system consists of multiple independently-deployed containers and scheduled handlers:

- **Agent Container** - Runs the custom headless executor in AWS Fargate; triggered by `agent` label on issues/PRs
- **Review Container** - Separate Fargate task definition; auto-reviews completed PRs every 15 minutes
- **Diagnostic Container** - Same image as agent but with read-only CloudWatch access; triggered by `diagnose` label
- **Webhook Handler Lambda** - Listens for GitHub webhook events (issues/PRs labeled `agent` or `diagnose`, PR reviews)
- **Review Handler Lambda** - Discovers PRs with `agent:succeeded` label and launches review tasks
- **Merge Triage Handler Lambda** - Plans merge order, labels merge readiness, updates stale branches, and safely lands approved PRs
- **Scheduled Operators** (EventBridge rules):
  - **Review runner** (15 minutes) - Trigger review handler for completed agent PRs
  - **Merge triage** (15 minutes) - Plan and advance the approved PR merge queue
  - **Cleanup handler** (every 2 hours) - Stop stale agent tasks, remove old metadata
  - **Daily digest** (9am UTC) - Post GitHub issue summarizing agent activity and credits
  - **QA trigger** (2am UTC) - Run nightly end-to-end tests
  - **Escalation checks** (every 15 minutes) - Route human-decision issues to admin
  - **Task status monitor** (every 30 minutes) - Health checks on running tasks
  - **Credit rescan** (hourly) - Unblock repos when credits become available
- **Infrastructure** - AWS CDK stack (`infra/`) defining Lambda, Fargate, VPC, S3, EventBridge rules

For security architecture and isolation controls, see [SECURITY.md](./SECURITY.md).
For the full runtime and control-plane map, see [docs/architecture.md](./docs/architecture.md).

## Full Pipeline

The complete workflow from issue to merge:

```
GitHub Issue
    ↓
  [agent] label added
    ↓
  Webhook Handler
    ↓
  Agent Container runs in Fargate
    ↓
  Creates PR (or modifies existing PR)
    ↓
  [agent:succeeded] label applied
    ↓
  Review Handler (every 15 min) discovers PR
    ↓
  Review Container evaluates quality
    ↓
  Review feedback posted as comment
    ↓
  [review:approved] or [review:changes-requested] label
    ↓
  Merge Triage Handler plans queue and file-overlap order
    ↓
  [merge:ready] / [merge:queued] / [merge:waiting] label
    ↓
  Merge after hold period only if a current human approval exists
```

### Label Semantics

The agent uses a trigger + status label system:

**Trigger Labels:**
- `agent` - Activates the agent on issues/PRs (automatically removed when processing starts)
- `diagnose` - Triggers read-only CloudWatch log investigation (diagnostic task)

**Status Labels:**
- `agent:running` - Agent is currently processing the issue/PR
- `agent:waiting` - Agent needs more information (re-add `agent` label to continue)
- `agent:failed` - Agent encountered an error and could not complete
- `agent:succeeded` - Agent completed successfully
- `agent:blocked` - Task blocked due to insufficient credits or dependency blocker

**Review Labels:**
- `review:approved` - Review agent approved the PR quality
- `review:changes-requested` - Review agent found issues needing fixes
- `review:human-required` - Protected files or policy require manual review; auto-merge is blocked

**Merge Labels:**
- `merge:ready` - PR is the next safe merge candidate for its repo
- `merge:queued` - PR is mergeable but waiting behind another overlapping PR or queue slot
- `merge:waiting` - PR is waiting for approval, checks, mergeability, or hold-period gates
- `merge:blocked` - PR has a policy or check blocker
- `merge:conflict` - PR has merge conflicts
- `merge:stale` - PR branch needs a base-branch update

**Status Labels:**
- `status:blocked` - Indicates task is blocked (credit-aware throttling)

### Expected Outputs

**For Issues:**
- Agent creates a new branch with implementing changes
- Agent creates a PR that links back to the original issue
- PR title follows format: "Implement #<issue-number>: <summary>"
- PR description includes "Fixes #<issue-number>"

**For Pull Requests:**
- Agent adds comments with review feedback or requested changes
- Agent may push commits to the PR branch if modifications are needed

### Retry Behavior

- **Failed Tasks**: Re-add the `agent` label to retry
- **Waiting Tasks**: Provide the requested clarification, then re-add `agent` label
- **Manual Stop**: Remove all agent labels to cancel a running task

## Best Practices

### Writing Effective Agent Issues

1. **Clear Problem Statement**: Describe what needs to be implemented or fixed
2. **Acceptance Criteria**: List specific requirements for completion
3. **Context**: Reference relevant files, functions, or existing behavior
4. **Constraints**: Mention any technical requirements or limitations

### Examples

**Good Issue:**
```
## Problem
The API returns 500 errors when users try to delete non-existent resources.

## Acceptance Criteria
- DELETE /api/resources/{id} returns 404 for non-existent resources
- Error response includes helpful message: "Resource {id} not found"
- Add test case covering this scenario

## Context
- Current behavior: `deleteResource()` in `src/api/resources.ts:45`
- Related issue: #123 (similar pattern for PATCH endpoints)
```

**Needs Improvement:**
```
Fix the delete bug
```

## Credit System

The agent uses a credit-based billing system to fund operations:

### Credit Model

Each task deducts credits based on the model used:

| Model | Credits | USD Value |
|-------|---------|-----------|
| z-ai/glm-5.2 | 12 | $1.20 |
| claude-haiku-4-5 | 4 | $0.40 |
| claude-sonnet-4-6 | 12 | $1.20 |
| claude-opus-4-6 | 20 | $2.00 |

### Initial Credits

New repositories receive **100 free credits** to get started (~25 Haiku tasks).

### Tracking Credits

Each repository has a credit balance stored in S3:
- **Balance file**: `s3://{bucket}/credits/{owner}/{repo}/balance.json`
- **Transaction ledger**: `s3://{bucket}/credits/{owner}/{repo}/ledger/{YYYY}/{MM}/transactions.jsonl`

### Low Balance Notifications

The daily digest includes warnings when reposit ories fall below 10 credits. Users can purchase additional credits through the payment system (coming soon).

### Failed Tasks

Tasks that fail or time out are not charged. Failed tasks receive a refund transaction in the ledger.

## Troubleshooting

- **Agent Not Triggering**: Ensure the `agent` label exists in your repository
- **Webhook Issues**: Check AWS CloudWatch logs for the webhook handler Lambda
- **Task Failures**: Look at the `agent:failed` status comment for error details
- **Long Running Tasks**: Agent has a 45-minute timeout for safety (prevents GitHub token expiration)
- **Insufficient Credits**: The `agent:failed` comment will show your current balance and required credits

## Orchestration Features

The agent system includes several advanced orchestration capabilities:

### Credit-Aware Throttling
- Repositories with insufficient credits are blocked with `agent:blocked` status
- Tasks do not consume credits if they fail or timeout
- Hourly credit rescan automatically unblocks repos when credits become available again

### Dependency-Aware Dispatch
- Agent detects and respects GitHub dependency linking (`depends-on` comments)
- Blocked PRs won't be processed until dependencies are resolved

### Merge Conflict Detection
- Merge triage labels conflicted PRs and requests branch updates for stale branches
- Prevents overlapping or stale PRs from being merged without a fresh queue pass

### Escalation Routing
- Complex decisions (security policies, breaking changes) route to human admins
- Escalation checks run every 15 minutes
- Tasks marked for escalation are removed from auto-merge queue

### Task Status Monitoring
- Health checks every 30 minutes on running tasks
- Automatic restart of stalled tasks
- Status metadata stored in S3 for debugging

## Scheduled Operations

All scheduled operations use EventBridge rules. Times listed are in UTC:

| Handler | Schedule | Purpose |
|---------|----------|---------|
| Review Handler | Every 15 minutes | Discover completed agent PRs and launch review tasks |
| Merge Triage Handler | Every 15 minutes | Plan merge order, sync `merge:*` labels, and land one safe PR per repo pass |
| Cleanup Handler | Every 2 hours | Stop stale tasks, remove old metadata after 30 days |
| Daily Digest | 9am daily | Post GitHub issue summarizing agent activity |
| QA Trigger | 2am daily | Run nightly end-to-end tests |
| Escalation Checks | Every 15 minutes | Route decisions to human admins |
| Task Status Monitor | Every 30 minutes | Health checks on running tasks |
| Credit Rescan | Hourly | Unblock repos when credits available |

## Deployment

GitHub Actions separates validation from deployment:

- `CI` runs on pull requests and pushes to `main`.
- `Deploy` runs only for published GitHub releases or manual `workflow_dispatch`.
- `Publish Benchmarks` publishes the static GitHub Pages benchmark dashboard on a 6-hour schedule, on manual `workflow_dispatch`, and when the Pages generator changes.

The CDK stack runs agent tasks in private subnets by default. To use the prior lower-cost public-subnet mode for a non-production deployment, pass `-c usePublicSubnets=true` to CDK.

## GitHub Pages Benchmarks

The benchmark site is generated from the S3 artifact bucket and published with GitHub Pages at the repository's Pages URL. It includes:

- 24-hour, 7-day, 30-day, and all-time task outcome statistics
- Runtime and queue-time benchmarks, including p50 and p95 runtime
- Model, executor, and task-mode benchmark breakdowns with credit spend
- Repository-level success rates and failure counts
- Credit balances, all-time spend, and recent credit activity
- Downloadable `data.json` and `tasks.csv` artifacts

The workflow uses `AWS_PAGES_ROLE_ARN` when present, otherwise it falls back to `AWS_DEPLOY_ROLE_ARN`. The role needs read access to:

```text
s3://github-agent-artifacts-022118847419-us-east-1/tasks/*
s3://github-agent-artifacts-022118847419-us-east-1/credits/*
```

Generate a local sample without AWS access:

```bash
cd scripts
npm ci
npm run build
npm run pages:report -- --sample --out ../pages
```

## Per-Repo Configuration

Repositories can customize agent behavior using `.github/AGENT.md`:

```yaml
# .github/AGENT.md
model: z-ai/glm-5.2  # Override model choice
conventions: |
  - Use PascalCase for class names
  - Use snake_case for functions
  - Always add tests for new features
instructions: |
  This repo uses async/await patterns exclusively.
  Prefer promises over callbacks.
  All HTTP requests must use the internal HTTP client.
```

When present, settings in `.github/AGENT.md` override repository defaults.

## Model Configuration

Default models by task type:

| Task Type | Model | Credits |
|-----------|-------|---------|
| Issues | `z-ai/glm-5.2` | 12 |
| PRs (review) | `z-ai/glm-5.2` | 12 |
| Planning | `z-ai/glm-5.2` | 12 |

Override using `.github/AGENT.md` in target repository (see Per-Repo Configuration above).

**Note:** Model names use OpenRouter format such as `z-ai/glm-5.2`.

## For External Repos

To install the agent on your repository:

1. **Install the GitHub App** - Visit the installation page for your organization
2. **Receive Initial Credits** - New repositories automatically receive 100 free credits
3. **Enable on an Issue** - Add the `agent` label to any issue
4. **Monitor in CloudWatch** - View logs: `aws logs tail /aws/lambda/GitHubAgentStack-WebhookHandler --follow`

The app will request these permissions:
- **Contents: Read/write** - Clone repository content, create branches, commit, and push changes
- **Issues: Read/write** - Read issue context, manage labels, and add comments
- **Pull requests: Read/write** - Create PRs, update PR metadata, and review PRs
- **Commit statuses: Read-only** - Read legacy commit status checks before dispatch/retry decisions
- **Checks: Read-only** - Read GitHub Actions check-runs before dispatch/retry decisions
- **Workflows: Read/write** - Work with workflow files when the agent changes CI-related code
- **Metadata: Read-only** - Access repository identity and installation metadata

After changing GitHub App permissions, repository or organization owners may need
to approve the updated installation before the new scopes appear in installation
tokens. You can audit the live app configuration with:

```bash
scripts/audit-github-app-permissions.sh atimics/AutoForwarder
```

## Error Handling

The agent categorizes and handles different failure modes:

- **Insufficient Credits**: Task blocked with `agent:blocked` label (retryable after credit purchase)
- **Permission Denied**: Escalated to admins, file changed to use different permissions strategy
- **Merge Conflicts**: Auto-rebased; if rebase fails, escalated for manual resolution
- **CI Failure**: Retried up to 2 times; if persistent, flagged as PR-introduced issue
- **Timeout (45 min)**: Fails gracefully to prevent token expiration race condition
- **Pre-existing Main Failure**: Not counted as agent failure; PR still approved if agent changes pass CI
