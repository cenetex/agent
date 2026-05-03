# Unblocker Failure-Graph Collector: Snapshot Schema

## Overview

The failure-graph collector runs every 15 minutes and produces a JSON snapshot of the current failure state across all monitored repositories. This snapshot serves as the data foundation for the unblocker system (root-cause analysis, blocking decisions, and corrective actions).

## Snapshot Storage

**Time-stamped snapshot:**
```
s3://github-agent-artifacts-{account}-{region}/unblocker/snapshots/{YYYY-MM-DD}-{HH-mm-ss}.json
```

**Latest snapshot (always points to most recent):**
```
s3://github-agent-artifacts-{account}-{region}/unblocker/snapshots/latest.json
```

## Top-Level Structure

```typescript
interface FailureSnapshot {
  // Unique snapshot identifier: "snapshot_{timestamp}_{random}"
  // Used for idempotency and tracking
  snapshot_id: string;

  // ISO 8601 timestamp when snapshot was collected
  // ISO format: "2026-05-03T15:23:45.123Z"
  collected_at: string;

  // Per-repository failure data
  // Key: repository slug in "owner/name" format
  // Example: {"cenetex/agent": {...}, "cenetex/kyro": {...}}
  repos: Record<string, RepoFailureData>;
}
```

## RepoFailureData Structure

```typescript
interface RepoFailureData {
  // Repository slug for reference (e.g., "cenetex/agent")
  repo_slug: string;

  // All open GitHub issues labeled with "agent:failed"
  // Sorted by issue number (ascending)
  issues: FailedIssue[];

  // All open GitHub PRs labeled with "agent:failed" or "agent:waiting"
  // Sorted by PR number (ascending)
  pull_requests: FailedPullRequest[];

  // Dependency graph edges: which issues/PRs block or fix which other issues
  // See CrossReference section for details
  cross_references: CrossReference[];

  // Aggregate statistics for this repository
  summary: {
    // Count of failed issues (with "agent:failed" label)
    total_failed: number;

    // Count of waiting issues (with "agent:waiting" label)
    total_waiting: number;
  };
}
```

## FailedIssue Structure

```typescript
interface FailedIssue {
  // GitHub issue number (unique within repo)
  number: number;

  // Issue title
  title: string;

  // Array of GitHub label names currently on this issue
  // Always includes "agent:failed"
  // Examples: ["agent:failed", "bug", "priority:high"]
  labels: string[];

  // Task ID of the last failed task for this issue
  // Corresponds to S3 path: tasks/{repo}/{task_id}/metadata.json
  // Null if no task metadata found
  last_failure_task_id: string | null;

  // First 200 characters of the error message from the last failed task
  // Useful for quick scanning
  // Null if no error message available
  last_error_excerpt: string | null;

  // Failure category from task metadata
  // Examples: "timeout", "credit_exhaustion", "auth_failure", "external_service"
  // Null if not categorized
  error_category: string | null;

  // Full GitHub URL to the issue
  // Format: "https://github.com/{owner}/{repo}/issues/{number}"
  github_url: string;

  // When the issue was created (ISO 8601 timestamp)
  created_at: string;

  // When the issue was last updated (ISO 8601 timestamp)
  last_updated: string;
}
```

## FailedPullRequest Structure

```typescript
interface FailedPullRequest {
  // GitHub PR number (unique within repo)
  number: number;

  // PR title
  title: string;

  // Array of GitHub label names currently on this PR
  // May include "agent:failed" or "agent:waiting"
  labels: string[];

  // Commit SHA at the head of the PR
  // Used to query check-runs status
  head_sha: string;

  // GitHub's merge state assessment
  // true = can be merged cleanly
  // false = has merge conflicts
  // null = unable to determine (e.g., branch deleted)
  mergeable: boolean | null;

  // Aggregated check-run status for this PR
  check_runs_summary: {
    // Total number of check runs (all statuses combined)
    total: number;

    // Number of check runs that failed
    failed: number;

    // Number of check runs still pending
    pending: number;

    // Number of check runs that passed
    passed: number;

    // Array of names of failed check runs
    // Examples: ["lint", "type-check", "integration-tests"]
    failed_checks: string[];
  };

  // Task ID of the last failed/waiting task for this PR
  // Null if no task metadata found
  last_failure_task_id: string | null;

  // First 200 characters of error message from last task
  // Null if no error message available
  last_error_excerpt: string | null;

  // Failure category from task metadata
  // Examples: "timeout", "credit_exhaustion", "auth_failure", "external_service"
  // Null if not categorized or still waiting
  error_category: string | null;

  // Full GitHub URL to the PR
  // Format: "https://github.com/{owner}/{repo}/pull/{number}"
  github_url: string;

  // When the PR was created (ISO 8601 timestamp)
  created_at: string;

  // When the PR was last updated (ISO 8601 timestamp)
  last_updated: string;
}
```

## CrossReference Structure

```typescript
interface CrossReference {
  // Type of relationship:
  // "fixes" = PR fixes an issue (from PR body: "Fixes #N")
  // "blocked_by" = issue blocked by another (from issue body: "Blocked by #M")
  type: "fixes" | "blocked_by";

  // Source of the reference (issue or PR)
  from: {
    // Issue or PR number
    issue_number: number;

    // Repository slug
    repo: string;

    // true if source is a PR, false if source is an issue
    is_pr: boolean;
  };

  // Target of the reference (what it fixes or depends on)
  to: {
    // Issue number being fixed or blocking
    issue_number: number;

    // Repository slug (may be different if cross-repo reference)
    repo: string;
  };
}
```

## Example Snapshot

```json
{
  "snapshot_id": "snapshot_1714764225000_abc123",
  "collected_at": "2026-05-03T15:23:45.123Z",
  "repos": {
    "cenetex/agent": {
      "repo_slug": "cenetex/agent",
      "issues": [
        {
          "number": 385,
          "title": "feat(unblocker): failure-graph collector",
          "labels": ["agent:failed", "enhancement"],
          "last_failure_task_id": "task_abc123_def456",
          "last_error_excerpt": "Timeout waiting for S3 response",
          "error_category": "timeout",
          "github_url": "https://github.com/cenetex/agent/issues/385",
          "created_at": "2026-05-02T12:00:00Z",
          "last_updated": "2026-05-03T15:20:00Z"
        }
      ],
      "pull_requests": [
        {
          "number": 388,
          "title": "fix: unblocker collector timeout handling",
          "labels": ["agent:waiting"],
          "head_sha": "abc123def456",
          "mergeable": true,
          "check_runs_summary": {
            "total": 3,
            "failed": 1,
            "pending": 0,
            "passed": 2,
            "failed_checks": ["lint"]
          },
          "last_failure_task_id": null,
          "last_error_excerpt": null,
          "error_category": null,
          "github_url": "https://github.com/cenetex/agent/pull/388",
          "created_at": "2026-05-03T14:00:00Z",
          "last_updated": "2026-05-03T15:10:00Z"
        }
      ],
      "cross_references": [
        {
          "type": "fixes",
          "from": {
            "issue_number": 388,
            "repo": "cenetex/agent",
            "is_pr": true
          },
          "to": {
            "issue_number": 385,
            "repo": "cenetex/agent"
          }
        }
      ],
      "summary": {
        "total_failed": 1,
        "total_waiting": 1
      }
    }
  }
}
```

## Notes on Collection Details

### Task Metadata Lookup

The collector searches S3 for the most recent task metadata file for each issue/PR:

1. Queries `tasks/{repo_slug}/` prefix in S3
2. Filters for files matching `/metadata.json`
3. Parses JSON and matches by `issue_number` and `status`
4. Returns the task with the most recent `created_at` timestamp

If no task is found, `last_failure_task_id` and error fields are `null`.

### Error Excerpts

The `last_error_excerpt` field contains the first 200 characters of the `error_message` field from the most recent failed task's metadata. This is intentionally truncated for:
- Efficient snapshot size
- Readability in logs and dashboards
- Full error details remain available by reading the full metadata.json from S3

### Check-Runs Status

Check-runs are fetched from GitHub API using the PR's `head_sha` (commit SHA). The status reflects the **most recent** check run for each check name. Possible statuses:
- `queued` or `in_progress` → counted as "pending"
- `completed` with `success` → counted as "passed"
- `completed` with `failure`, `timed_out`, `cancelled`, or `action_required` → counted as "failed"

### Cross-References

Cross-references are extracted by parsing issue/PR body text:

- **"Fixes #N"** patterns → creates `fixes` reference (PR → Issue)
  - Variants: "Closes #N", "Resolves #N"
  - Supports cross-repo: "Fixes owner/repo#N"

- **"Blocked by #M"** patterns → creates `blocked_by` reference (Issue → blocking Issue)
  - Supports cross-repo: "Blocked by owner/repo#M"

Only parsed if found; no validation or verification performed.

### Snapshot Size & Performance

Typical snapshot size for 7 monitored repos:
- ~10-20 failed issues per repo
- ~5-10 failed/waiting PRs per repo
- Total: ~300-500 KB JSON (depends on error message lengths)

Collection time per repo: ~2-5 seconds (depends on GitHub API rate limits)

## Consuming the Snapshot

### Programmatic Access

```typescript
async function loadLatestSnapshot(): Promise<FailureSnapshot> {
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: "unblocker/snapshots/latest.json",
    })
  );
  const content = await result.Body.transformToString();
  return JSON.parse(content);
}

// Iterate over repositories
const snapshot = await loadLatestSnapshot();
for (const [repoSlug, repoData] of Object.entries(snapshot.repos)) {
  console.log(`${repoSlug}: ${repoData.summary.total_failed} failed, ${repoData.summary.total_waiting} waiting`);
}
```

### CloudWatch Metrics

The collector publishes:
- **Metric:** `UnblockerCollector.SnapshotItems`
- **Value:** Total count of (failed issues + failed/waiting PRs) across all repos
- **Unit:** Count
- **Namespace:** `UnblockerCollector`

## Schema Versioning

Currently at **v1.0**. If schema changes are needed:
1. Add `schema_version: "2.0"` field to top level
2. Commit both v1 and v2 features
3. Update this documentation
4. Increment minor version in package.json if significant change

No backward compatibility guarantee between versions.
