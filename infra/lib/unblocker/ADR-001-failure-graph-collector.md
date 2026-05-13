# ADR-001: Failure-Graph Collector Design

**Status:** Accepted  
**Date:** 2026-05-06  
**Deciders:** Architecture Review Board  
**Related PRs:** #386, #387  
**Related issues:** #316 (unblocker handler epic), #385

---

## Context

The unblocker handler epic (#316) requires a structured view of which agent tasks are blocked, why they failed, and what their dependencies are. PR #387 implements the collector sub-component: an EventBridge cron Lambda that runs every 15 minutes, queries GitHub for `agent:failed` and `agent:waiting` issues/PRs, reads S3 task metadata for error details, and writes a timestamped JSON snapshot to S3.

No record exists of why polling was chosen over push (GitHub webhooks), or what the GitHub API rate-limit envelope looks like at current and projected fleet sizes.

## Decision

Use **EventBridge cron polling at 15-minute intervals** for the failure-graph collector.

### Rationale

- **Slow-changing state:** The collector aggregates state that changes slowly (tasks fail, stay failed until retried). 15-minute freshness is sufficient for the unblocker's use case.
- **Simpler implementation:** A push model (GitHub webhooks on `labeled` events) would require the collector to maintain incremental state and handle out-of-order delivery. The snapshot model is simpler: each run produces a complete picture.
- **Debug-friendly:** The snapshot pattern is useful for post-mortems: each timestamped JSON in S3 is a point-in-time record of fleet state, readable without tooling.

### Rate-Limit Analysis (Current Fleet)

- GitHub App installation tokens: 5,000 requests/hour per installation.
- Per collector run: ~1 GitHub API call to list issues (paginated), plus 1 check-runs call per PR with `agent:waiting`. At current fleet size (< 50 active tasks at any time), this is well within limits.
- **Scale trigger:** At ~500 concurrent active tasks, a single collector run could approach 500+ API calls per 15 minutes (~2,000/hour), consuming 40% of the rate-limit budget. If the fleet reaches this size, switch to an incremental model driven by webhook events.

### S3 Snapshot Schema

The snapshot is documented in `infra/lib/unblocker/SCHEMA.md`. The `latest.json` pointer enables the classifier (sub-issue 2) and action planner (sub-issue 3) to always read a fresh snapshot without listing the S3 prefix.

## Consequences

### 15-Minute Blindspot
A task that fails and is retried within 15 minutes may not appear in any snapshot. This is acceptable for the current use case (unblocker acts on persistent failures, not transient ones).

### Snapshot Accumulation
Timestamped snapshots in S3 will accumulate indefinitely. Add an S3 lifecycle policy to expire snapshots older than 30 days before the unblocker reaches production.

### Eventually Consistent Reads
The collector writes snapshots then updates `latest.json`. A reader that sees `latest.json` pointing to a snapshot that doesn't yet exist will get a 404. The classifier must handle this with a short retry.

### Inline Duplication in `triage-handler.ts`
The issue/PR query logic in the collector duplicates patterns from the webhook handler. This is acceptable for now; consolidate into a shared `github-client.ts` helper when a third component needs the same queries.

## Alternatives Considered

### GitHub Webhooks (Push Model)
- **Pros:** Eliminates polling latency, reduces API calls.
- **Cons:** Requires stateful incremental accumulation, out-of-order event handling, webhook infrastructure.
- **Decision:** Rejected at this stage; revisit when fleet size makes polling cost prohibitive (see scale trigger above).

### 1-Minute Polling
- **Pros:** Near-real-time failure detection.
- **Cons:** Overkill for use case; 4× API call volume for marginal freshness improvement.
- **Decision:** Rejected.

### DynamoDB as Snapshot Store
- **Pros:** More queryable than S3.
- **Cons:** More expensive; S3 JSON is human-readable for debugging, sufficient for sequential read pattern.
- **Decision:** Rejected.

## Action Items

- [ ] Add S3 lifecycle policy: expire `unblocker/snapshots/` objects older than 30 days
- [ ] Document the scale trigger (500 concurrent tasks → switch to incremental/webhook model) in the unblocker epic (#316)
- [ ] Add retry logic in the classifier for the `latest.json` eventual-consistency window
- [ ] Revisit polling cadence when fleet size crosses 100 concurrent active tasks

## Implementation

The collector is implemented in `infra/lib/unblocker/collector.ts` with the following key behaviors:

1. **EventBridge Rule:** Triggers on a 15-minute schedule.
2. **GitHub Query:** Fetches all issues/PRs labeled with `agent:failed` or `agent:waiting` across monitored repositories.
3. **S3 Task Metadata:** Reads S3 for error details and categorization for each failed task.
4. **Snapshot Generation:** Produces a single JSON snapshot with all failure state.
5. **Timestamp Management:** Writes to `unblocker/snapshots/{YYYY-MM-DD}-{HH-mm-ss}.json` and updates `latest.json`.

## References

- `infra/lib/unblocker/collector.ts` — Collector implementation
- `infra/lib/unblocker/SCHEMA.md` — Snapshot schema and structure
- Issue #316 — Unblocker handler epic
- PR #387 — Collector implementation PR
