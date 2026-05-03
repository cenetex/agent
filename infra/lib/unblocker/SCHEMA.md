# Failure-Graph Collector Schema

## Overview

The Unblocker Collector generates a JSON snapshot of failure state across monitored repositories. This snapshot is collected every 15 minutes and published to S3 for downstream processing by the unblocker handler's reasoning and action components.

## Snapshot Output Locations

- **Timestamped snapshots**: `s3://github-agent-artifacts-{account}-{region}/unblocker/snapshots/YYYY-MM-DD-HH-mm.json`
- **Latest snapshot link**: `s3://github-agent-artifacts-{account}-{region}/unblocker/snapshots/latest.json`

## Root Schema: FailureGraphSnapshot

```typescript
interface FailureGraphSnapshot {
  // Timestamp of snapshot in format YYYY-MM-DD-HH-mm
  timestamp: string;

  // ISO 8601 timestamp of when snapshot was generated
  generated_at: string;

  // Array of repository snapshots
  repos: RepoSnapshot[];

  // Total count of failed issues + failed/waiting PRs across all repos
  item_count: number;
}
```

## Repository Snapshot: RepoSnapshot

Captured snapshot for a single repository.

```typescript
interface RepoSnapshot {
  // Repository slug in format owner/name (e.g., "cenetex/agent")
  repo: string;

  // ISO 8601 timestamp when this repo snapshot was collected
  timestamp: string;

  // Array of all open issues labeled with agent:failed
  failed_issues: FailedIssue[];

  // Array of all open PRs labeled with agent:failed or agent:waiting
  failed_or_waiting_prs: FailedPR[];

  // Cross-reference map between issues and PRs
  cross_references: CrossReference[];
}
```

## Failed Issue: FailedIssue

Represents an issue that failed during autonomous execution.

```typescript
interface FailedIssue {
  // GitHub issue number
  number: number;

  // Issue title as of snapshot time
  title: string;

  // Array of label names on the issue
  labels: string[];

  // Task ID of the most recent failed execution
  last_failure_task_id: string;

  // Last 500 characters of the last 50 lines from agent.log
  last_error_excerpt: string;

  // Exit code from the task execution (if available)
  exit_code?: number;

  // Calculated failure category (e.g., "credit_exhaustion", "timeout", "auth_failure")
  failure_category?: string;
}
```

## Failed/Waiting PR: FailedPR

Represents a PR that failed or is waiting during autonomous review/processing.

```typescript
interface FailedPR {
  // GitHub PR number
  number: number;

  // Head commit SHA of the PR
  head_sha: string;

  // GitHub's mergeable status (true/false/null if unknown)
  mergeable: boolean | null;

  // Summary of check-run status from GitHub Actions
  check_runs_summary: {
    // Total number of check-runs on this commit
    total: number;

    // Number of check-runs that have completed
    completed: number;

    // Conclusion of the first check-run (e.g., "success", "failure", "neutral")
    conclusion?: string;
  };

  // Task ID of the most recent failed or waiting execution
  last_failure_task_id: string;

  // Last 500 characters of the last 50 lines from agent.log
  last_error_excerpt: string;

  // Exit code from the task execution (if available)
  exit_code?: number;

  // Calculated failure category
  failure_category?: string;
}
```

## Cross-Reference: CrossReference

Maps relationships between issues and PRs (Fixes #N, blocked by #M links).

```typescript
interface CrossReference {
  // The issue number being referenced
  issue_number: number;

  // If this issue has a PR that fixes it (from "Fixes #N" in PR body)
  fixing_pr?: number;

  // Array of issue numbers that block this issue (from "blocked by #M" in issue body)
  blocked_by?: number[];
}
```

## Data Collection Flow

1. **Lambda Invocation**: EventBridge trigger every 15 minutes
2. **GitHub Authentication**: Fetch app credentials from SSM Parameter Store
3. **Repository Iteration**: For each configured repository:
   - Query open issues with `agent:failed` label
   - Query open PRs with `agent:failed` or `agent:waiting` labels
   - For each failed/waiting item, retrieve its most recent task metadata from S3
   - Extract error excerpts from agent logs
   - Fetch check-run summaries (PRs only)
   - Parse issue/PR body for cross-references
4. **Snapshot Assembly**: Combine all repo data into a single snapshot object
5. **S3 Write**: Persist snapshot to both timestamped and `latest.json` paths
6. **Metric Publication**: Publish `UnblockerCollector.SnapshotItems` to CloudWatch

## Example Snapshot

```json
{
  "timestamp": "2026-05-03-14-30",
  "generated_at": "2026-05-03T14:30:45.123Z",
  "repos": [
    {
      "repo": "cenetex/agent",
      "timestamp": "2026-05-03T14:30:40.000Z",
      "failed_issues": [
        {
          "number": 385,
          "title": "feat(unblocker): failure-graph collector",
          "labels": ["enhancement", "agent:failed"],
          "last_failure_task_id": "task_abc123",
          "last_error_excerpt": "Error: insufficient credits\nRetry available",
          "exit_code": 1,
          "failure_category": "credit_exhaustion"
        }
      ],
      "failed_or_waiting_prs": [
        {
          "number": 102,
          "head_sha": "abc1234567890def",
          "mergeable": true,
          "check_runs_summary": {
            "total": 3,
            "completed": 2,
            "conclusion": "failure"
          },
          "last_failure_task_id": "task_xyz789",
          "last_error_excerpt": "Lint check failed",
          "exit_code": 1,
          "failure_category": "lint_failure"
        }
      ],
      "cross_references": [
        {
          "issue_number": 385,
          "fixing_pr": 102
        }
      ]
    }
  ],
  "item_count": 2
}
```

## CloudWatch Metrics

### UnblockerCollector.SnapshotItems

- **Namespace**: UnblockerCollector
- **MetricName**: SnapshotItems
- **Value**: Total count of failed issues + failed/waiting PRs across all repos
- **Unit**: Count
- **Frequency**: Every 15 minutes (when collector runs)
- **Use case**: Monitor total failure backlog volume

## Notes

- All timestamps in `generated_at` and `timestamp` fields use ISO 8601 format
- Snapshot files are immutable — historical snapshots remain available for trend analysis
- The `latest.json` file is always the most recent snapshot (overwritten every 15 minutes)
- Error excerpts are truncated to 500 characters and sampled from the last 50 log lines
- Cross-references are extracted via regex patterns: `[Ff]ixes #N` and `[Bb]locked by #M`
- Out of scope: reasoning about why failures occurred, actions to resolve them, cross-repo linking
