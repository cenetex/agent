# GitHub Agent

Fargate container that runs Claude Code on GitHub issues/PRs.

## Quick Start

To trigger the agent on an issue or PR:
1. Add the `agent` label to any issue or PR
2. The agent will automatically remove the `agent` label and add `agent:running`
3. When complete, the agent will create a PR (for issues) or comment (for PRs)
4. Final status will be shown with `agent:succeeded` or `agent:failed`

## Architecture

- **Webhook Handler** (`infra/lib/webhook-handler.ts`) - Listens for `agent` label events
- **Agent Container** - Runs Claude Code in AWS Fargate
- **Infrastructure** - AWS CDK deployment in `infra/`

For security architecture and isolation controls, see [SECURITY.md](./SECURITY.md).

## Agent Workflow

### Label Semantics

The agent uses a trigger + status label system:

**Trigger Label:**
- `agent` - Activates the agent (automatically removed when processing starts)

**Status Labels:**
- `agent:running` - Agent is currently processing the issue/PR
- `agent:waiting` - Agent needs more information (re-add `agent` label to continue)
- `agent:failed` - Agent encountered an error and could not complete
- `agent:succeeded` - Agent completed successfully

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

## Configuration

### Per-Repository Customization

Each repository can customize agent behavior by creating a `.github/AGENT.md` file:

```markdown
model: anthropic/claude-opus-4-6
```

This overrides the default model selection:
- **Issues**: `anthropic/claude-haiku-4-5` (default)
- **Pull Requests**: `anthropic/claude-sonnet-4-6` (default)

The agent reads `.github/AGENT.md` from the target repository to apply model overrides and future customization options.

## Review Pipeline

The agent includes an automated review system that runs on agent-created PRs:

1. **Triggered by**: `agent:succeeded` label on issues that created PRs
2. **Review process**: Separate review container analyzes code quality, tests, and best practices
3. **Review labels**:
   - `review:approved` - Ready for auto-merge
   - `review:changes-requested` - Changes needed before merge
4. **Auto-merge**: PRs with `review:approved` label are automatically merged after a 1-hour hold period
5. **Status labels**: `agent:succeeded` → reviewed → `review:approved` → auto-merged

### Orchestration Features

The agent includes several coordination and reliability features:

- **Credit-aware throttling** — Tasks are blocked with `agent:blocked` status when insufficient credits
- **Dependency-aware dispatch** — Detects blocked-by relationships and schedules dependent tasks
- **Merge conflict detection** — Automatically detects and attempts rebase for conflicts
- **Escalation routing** — Human decisions are escalated with context
- **Hourly credit rescan** — Unblocks repositories when credits become available
- **30-minute health checks** — Task status handler monitors running tasks for failures

## Diagnostic Tasks

Tasks labeled with `diagnose` run a read-only diagnostic agent that:
- Has access to CloudWatch Logs for troubleshooting
- Analyzes Lambda function logs for errors and patterns
- Reports findings directly as an issue comment
- Closes the issue when diagnostics complete

## Scheduled Operations

EventBridge rules trigger several background handlers:

| Handler | Schedule | Purpose |
|---------|----------|---------|
| Review | Every 15 minutes | Discover and review agent-created PRs |
| Cleanup | Every 2 hours | Stop stale tasks, remove old metadata |
| Daily Digest | 9am UTC daily | Activity summary posted as GitHub issue |
| Credit Rescan | Every hour | Unblock repos when credits become available |
| Escalation Checks | Every 15 minutes | Route conflicts and decisions requiring human input |
| Task Status | Every 30 minutes | Health check running tasks for failures |
| QA Trigger | 2am UTC daily | Create nightly QA issues for system health |

## Testing & Monitoring

- **Label an issue** with `agent` to trigger a test run
- **View CloudWatch logs**: `aws logs tail /aws/lambda/GitHubAgentStack-WebhookHandler --follow`
- **S3 artifacts**: Task logs and metadata available at `s3://{bucket}/{prefix}/`

## Architecture

### Containers

- **Agent Container** — Main coding agent (blue-green deployment, runs agent.ts tasks)
- **Review Container** — PR review agent (separate task definition, triggered by EventBridge)
- **Diagnostic Container** — Log analysis and troubleshooting (same image, different IAM role with CloudWatch read access)

### Infrastructure

- **VPC**: Public subnets only (no NAT gateway for cost efficiency)
- **ECS Fargate**: Isolated task execution with per-task IAM roles
- **S3**: Artifact storage (agent logs, task metadata, review findings)
- **Lambda**: Webhook handler, scheduled handlers (digest, cleanup, credit rescan, escalation, task status)
- **EventBridge**: Orchestration and scheduling (7 scheduled rules)

### Deploy Failure Auto-Issues

The webhook handler monitors GitHub Actions workflows and automatically creates issues for deploy failures, enabling the agent to investigate and respond to CI/CD problems.

## Full Pipeline

Issue → Agent → PR → Review → Auto-Merge

```
1. User labels issue with 'agent'
   ↓
2. Webhook handler receives event
   ↓
3. Agent container starts (Fargate task)
   ↓
4. Agent implements the feature/fix and creates PR
   ↓
5. Review agent (EventBridge 15min) discovers the PR
   ↓
6. Review container analyzes code and applies review label
   ↓
7. If approved, auto-merge after 1hr hold period
   ↓
8. Credits deducted from repository balance
```

## For External Repos

To use the GitHub Agent on your repository:

1. **Install the App** — Add GitHub Agent installation to your org
2. **Initial Credits** — Receive 100 free credits (~25 Haiku tasks)
3. **Basic Usage** — Label any issue with `agent` to start
4. **Advanced** — Create `.github/AGENT.md` to customize (model override, etc.)
5. **Monitor** — Check daily digest for activity and credit usage

## Credit System

The agent uses a credit-based billing system to fund operations:

### Credit Model

Each task deducts credits based on the model used:

| Model | Credits | USD Value |
|-------|---------|-----------|
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
- **Long Running Tasks**: Agent has a 45-minute timeout for safety
- **Insufficient Credits**: The `agent:failed` comment will show your current balance and required credits