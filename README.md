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

## GitHub-Only Operator Guide

Once the agent is set up, the entire workflow can be run from GitHub.com without ever opening a terminal:

### Daily Workflow

1. **Open your daily digest** — The agent posts an issue every morning at 9am UTC with:
   - Summary of agent task outcomes (✅ succeeded, ❌ failed, ⏱️ timed out)
   - Link to any **draft releases** waiting to be published
   - List of **PRs awaiting human review** (if any)
   - Credit balance and low-balance warnings
   - All merged PRs from the past 24 hours

2. **Ship a release (if draft exists)**
   - Click the draft release link in the daily digest
   - Review the auto-generated release notes
   - Click "Publish release" button
   - The deployment workflow automatically triggers on the release tag

3. **Review and merge PRs**
   - Click PR links in the digest
   - Click the green "Merge pull request" button when ready
   - The agent automatically creates follow-up issues for agent-authored PRs

4. **Trigger the agent**
   - Create a new GitHub issue or find an existing one
   - Click the label icon on the issue
   - Type "agent" to search for the agent label
   - Click the label to add it
   - The agent will start automatically (you'll see `agent:running` label)

5. **Monitor results**
   - The agent adds `agent:succeeded` or `agent:failed` label when done
   - For issues: the agent creates a PR (click the link in the issue comments)
   - For PRs: the agent adds review comments directly
   - Check CloudWatch logs for detailed output if needed

### Release Management

**Auto-Draft Releases**
- After 5 PRs merge, the agent automatically creates a draft release
- The draft includes auto-generated release notes from PR titles and authors
- No manual work needed — just review and publish

**Deploy on Publish**
- When you click "Publish release" on GitHub, the workflow automatically deploys
- Deployment includes CDK infrastructure updates and Docker image push to ECR
- Note: Ensure `.github/workflows/deploy.yml` has `tags: ['v*']` trigger

### What You'll See

|Action|Location|Result|
|------|--------|------|
|Create issue + add `agent` label|GitHub.com|Agent processes immediately; label becomes `agent:running`|
|Merge a PR|GitHub.com|Agent creates follow-up issue automatically|
|Publish a draft release|GitHub.com|Deployment workflow triggers automatically|
|Opening daily digest|GitHub.com notifications|All actionable items in one place|

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
- **Long Running Tasks**: Agent has a 30-minute timeout for safety
- **Insufficient Credits**: The `agent:failed` comment will show your current balance and required credits