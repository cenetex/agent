# Escalation Routing System

## Overview

The escalation system automatically routes issues and PRs requiring human judgment to a visible, human-maintained escalation queue. This prevents important items from getting lost in `agent:waiting` or `agent:failed` labels.

## Architecture

The escalation system consists of three components:

1. **Escalation Handler** (`infra/lib/escalation-handler.ts`) - Lambda that manages the escalation queue
2. **Task Status Handler** (`infra/lib/task-status-handler.ts`) - Lambda that detects escalation triggers
3. **Webhook Integration** (`infra/lib/webhook-handler.ts`) - Detects escalation triggers during task processing
4. **Types and Utilities** (`infra/lib/types.ts`) - Escalation data structures and S3 paths

## Escalation Triggers

The system detects and routes the following escalation triggers:

### 1. Repeated Failures (`repeated_failure`)
- **Trigger:** Agent fails on the same issue 3+ times within 7 days (configurable)
- **Detection:** Task Status Handler (every 30 minutes)
- **Suggested Action:** Review issue description and agent logs; may need manual investigation or scope refinement
- **Example:** Issue #42 has failed 3 times; human should review and clarify requirements

### 2. PR Staleness (`pr_stale`)
- **Trigger:** PR has been open >48 hours (configurable) with no merge (implemented in review-handler)
- **Detection:** Review Handler (every 15 minutes)
- **Suggested Action:** Review for conflicts, merge blockers, or stale reviews
- **Example:** PR #15 is open for 72 hours; check if it's waiting for approval or has blockers

### 3. Waiting Question (`waiting_question`)
- **Trigger:** Agent asks a question (`agent:waiting`) that can't be resolved from repo context
- **Detection:** Webhook at task creation (via context detection)
- **Suggested Action:** Review the question and provide clarification in issue comments
- **Example:** Agent needs architectural guidance that requires human decision

### 4. Security-Sensitive (`security_sensitive`)
- **Trigger:** Issue/PR has security-related labels (security, CVE, vulnerability)
- **Detection:** Webhook Handler (at task launch)
- **Suggested Action:** Manual security review required before proceeding
- **Example:** PR modifying authentication or encryption code

### 5. Production Config (`production_config`)
- **Trigger:** Issue/PR touches critical files (deploy config, secrets, infrastructure)
- **Detection:** Webhook Handler (at task launch) or Task Status Handler
- **Suggested Action:** Manual review required; do not auto-merge
- **Example:** PR modifying `.github/workflows/` or `infra/lib/stack.ts`

### 6. Low Credits (`low_credits`)
- **Trigger:** Repository credit balance drops below threshold (default: 5 credits)
- **Detection:** Task Status Handler (every 30 minutes)
- **Suggested Action:** Purchase credits to continue using the agent
- **Example:** Repo account has 2 credits left; can only run 1 task

## Escalation Queue

The escalation queue is a persistent S3 JSON file at `escalations/{repoSlug}/queue.json`:

```json
{
  "items": [
    {
      "escalation_id": "esc_xyz123_abc456",
      "repo_slug": "owner/repo",
      "issue_number": 42,
      "trigger_type": "repeated_failure",
      "reason": "Agent failed 3 times on this issue",
      "suggested_action": "Review issue description and agent logs; may need manual investigation or scope refinement.",
      "github_url": "https://github.com/owner/repo/issues/42",
      "created_at": "2026-03-27T16:30:00Z",
      "context": {
        "failure_count": 3,
        "threshold": 3
      }
    }
  ],
  "updated_at": "2026-03-27T16:35:00Z",
  "version": 42
}
```

## Escalation Issue

The system maintains a pinned issue in `cenetex/agent` repository labeled `escalation:queue` that displays all active escalations:

- **Title:** 🚨 Escalations Queue
- **Label:** `escalation:queue`
- **Content:** Auto-updated table of all active escalations with:
  - Repository identifier
  - Issue/PR link
  - Trigger reason
  - Suggested action

The table is updated every 15 minutes and provides a single, visible location for tracking all items needing human attention.

## De-escalation

Items are automatically removed from the escalation queue when:

1. **Issue is resolved** - When the underlying issue is closed/resolved
2. **PR is merged** - When the PR is successfully merged
3. **Question is answered** - When `agent:waiting` label is removed and issue progresses
4. **Credits are purchased** - When credit balance exceeds the low threshold

Manual de-escalation is also possible by directly editing the escalation queue (advanced).

## Configuration

Each repository has an escalation configuration file at `escalations/{repoSlug}/config.json`:

```json
{
  "repo_slug": "owner/repo",
  "enabled": true,
  "failure_threshold": 3,
  "pr_staleness_hours": 48,
  "low_credit_threshold": 5,
  "webhook_url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
  "updated_at": "2026-03-27T16:00:00Z"
}
```

**Configuration Options:**

- `enabled` - Enable/disable escalation detection for this repo (default: true)
- `failure_threshold` - Number of failures before escalating (default: 3)
- `pr_staleness_hours` - Hours a PR can be open before escalating (default: 48)
- `low_credit_threshold` - Minimum credits before escalating (default: 5)
- `webhook_url` - Optional Slack/Telegram webhook for real-time notifications

## API Reference

### Scalation Handler

**File:** `infra/lib/escalation-handler.ts`

Functions exported for integration with other systems:

#### `addEscalation()`

Adds or updates an escalation item:

```typescript
await addEscalation(
  repoSlug: string,
  issueNumber: number,
  triggerType: string,
  reason: string,
  suggestedAction: string,
  githubUrl: string,
  config: EscalationConfig,
  token: string,
  context?: Record<string, any>
): Promise<void>
```

#### `removeEscalation()`

Removes an escalation item from the queue:

```typescript
await removeEscalation(
  repoSlug: string,
  escalationId: string,
  token: string
): Promise<void>
```

### Task Status Handler

**File:** `infra/lib/task-status-handler.ts`

Functions exported for use in task processing:

#### `handleTaskFailure()`

Called when a task completes with status "failed":

```typescript
await handleTaskFailure(
  taskMetadata: TaskMetadata,
  token: string
): Promise<void>
```

This function:
- Checks if the issue now has ≥3 failures
- Creates a `repeated_failure` escalation if threshold is reached
- Updates the escalation queue and GitHub issue

#### `checkRepeatedFailures()`

Manually check and escalate if failure threshold is reached:

```typescript
await checkRepeatedFailures(
  repoSlug: string,
  issueNumber: number,
  token: string,
  config: EscalationConfig
): Promise<void>
```

## Integration Points

### 1. Webhook Handler Integration

When a task is requested/fails, the webhook handler checks for security and production config escalation triggers:

```typescript
// In webhook-handler.ts, after task launch
await checkAndTriggerEscalations(
  repoOwner,
  repoName,
  issueNumber,
  isPR,
  labels,
  taskStatus,
  token
);
```

### 2. Task Completion Integration

When a task completes with failure status, the agent should call:

```typescript
// In agent container, after marking task as failed
await handleTaskFailure(taskMetadata, githubToken);
```

### 3. Review Handler Integration

When a PR is stale (open >48 hours without merge), review-handler adds a `pr_stale` escalation.

### 4. Periodic Checks

- **Every 15 minutes:** Escalation Handler updates the queue and GitHub issue
- **Every 30 minutes:** Task Status Handler checks for repeated failures and low credits

## Webhook Notifications (Optional)

If a `webhook_url` is configured in the escalation config, new escalations are sent to Slack/Telegram:

```text
🚨 **New Escalation**: owner/repo#42
Agent failed 3 times on this issue
Review issue description and agent logs; may need manual investigation or scope refinement.
[View Issue] button
```

This enables real-time alerting without constantly monitoring the GitHub issue.

## S3 Storage Structure

```
escalations/
├── owner/repo/
│   ├── config.json                    # Escalation configuration
│   ├── queue.json                     # Active escalation queue
│   └── history/
│       └── 2026-03-27/
│           └── events.jsonl           # Daily escalation event log
```

**Storage Patterns:**
- `config.json` - Small, infrequently updated
- `queue.json` - Updated every 15 minutes
- `history/YYYY-MM-DD/events.jsonl` - Append-only log, rotates daily

## Monitoring and Observability

### CloudWatch Logs

Each Lambda logs its operations:

```text
[escalation-handler] Saved escalation queue for owner/repo (version 42)
[escalation-handler] Updated escalation issue #15 with 3 items
[task-status-handler] Added repeated_failure escalation for owner/repo#42
```

### Metrics

Consider tracking via CloudWatch:
- Number of active escalations by trigger type
- Time-to-escalation (avg time from trigger to queuing)
- De-escalation rate (% that recover)
- Escalation queue size over time

### Debugging

To inspect an escalation queue:

```bash
aws s3 cp s3://github-agent-artifacts-ACCOUNT-REGION/escalations/owner/repo/queue.json - | jq
```

To view escalation history:

```bash
aws s3 cp s3://github-agent-artifacts-ACCOUNT-REGION/escalations/owner/repo/history/2026-03-27/events.jsonl - | jq -s
```

## Troubleshooting

### Why isn't an issue escalating?

1. **Escalation disabled** - Check `config.json` has `enabled: true`
2. **Threshold not met** - Default is 3 failures; check via: `aws s3 cp s3://.../tasks/owner/repo/*/metadata.json - | jq '. | select(.status == "failed" and .issue_number == 42)'`
3. **Lambda not running** - Check CloudWatch logs for `EscalationRule` or `TaskStatusRule`

### Escalations aren't updating the GitHub issue

1. Check escalation-handler CloudWatch logs for errors
2. Verify the orchestrator repo (`cenetex/agent`) installation token has write access
3. Ensure GitHub App has `issues` scope for write permissions

### How to manually add an escalation (advanced)

1. Load the current queue: `aws s3 cp s3://.../escalations/owner/repo/queue.json ./queue.json`
2. Edit `queue.json` to add item manually (include `escalation_id`, timestamps, etc.)
3. Upload: `aws s3 cp ./queue.json s3://.../escalations/owner/repo/queue.json`
4. Escalation handler will update GitHub issue on next run

## Future Enhancements

1. **Manual escalation triggers** - Allow humans to manually escalate via issue comment
2. **Escalation templates** - Customizable reason/action templates per repo
3. **Escalation metrics dashboard** - Grafana dashboard showing escalation trends
4. **Escalation notifications** - Email, Slack threads, or PagerDuty integration
5. **Smart de-escalation** - Detect when escalation is likely resolved (e.g., PR merged)
6. **Per-trigger webhooks** - Different webhook URLs for different trigger types

## Related Issues

- **#102** - Parent epic for orchestrator improvements
- **#112** - Escalation routing feature (this implementation)
- **#107** - Automated PR review trigger (integration point)
