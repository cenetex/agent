# ADR: Failure-Graph Collector Design

**Status:** Approved  
**Date:** 2026-05-06  
**Deciders:** Architecture Review Board  
**Related PRs:** #386, #387  
**Related issues:** #316 (unblocker handler epic), #385

---

## Context

The unblocker handler epic (#316) requires a structured view of which agent tasks are blocked, why they failed, and what their dependencies are. The failure-graph collector—an EventBridge cron Lambda that runs every 15 minutes—queries GitHub for `agent:failed` and `agent:waiting` issues/PRs, reads S3 task metadata for error details, and writes a timestamped JSON snapshot to S3.

No record existed of why polling was chosen over push (GitHub webhooks), or what the GitHub API rate-limit envelope looks like at current and projected fleet sizes. This ADR documents those decisions.

---

## Decision

Use **EventBridge cron polling at 15-minute intervals** for the failure-graph collector.

### Rationale

1. **Slow-changing state:** The collector aggregates state that changes slowly. Tasks fail and stay failed until retried. 15-minute freshness is sufficient for the unblocker's use case.

2. **Simpler model:** A push model (GitHub webhooks on `labeled` events) would require maintaining incremental state and handling out-of-order delivery. The snapshot model is simpler: each run produces a complete picture.

3. **Debugging value:** Each timestamped JSON in S3 is a point-in-time record of fleet state, readable without tooling.

4. **Acceptable trade-offs:** A 15-minute blindspot (task fails and is retried within 15 minutes) is acceptable; the unblocker acts on persistent failures, not transient ones.

### Rate-Limit Analysis (Current Fleet)

- **GitHub App limits:** 5,000 requests/hour per installation token
- **Per collector run:** ~1 GitHub API call to list issues (paginated) + 1 check-runs call per PR with `agent:waiting`
- **Current load:** < 50 concurrent active tasks → well within limits
- **Cost per hour:** ~16 API calls (4 runs × 4 calls each), leaving 4,984 calls/hour for other components

### Scale Trigger

At ~500 concurrent active tasks, a single collector run could approach 500+ API calls per 15 minutes (~2,000/hour), consuming 40% of the rate-limit budget. **If fleet reaches this size, evaluate switching to an incremental model driven by webhook events.**

---

## Consequences

### S3 Snapshot Accumulation

Timestamped snapshots in S3 accumulate indefinitely. **Action:** Add an S3 lifecycle policy to expire snapshots older than 30 days before unblocker reaches production (see `infra/lib/stack.ts`).

### `latest.json` Eventual Consistency

The collector writes snapshots then updates `latest.json`. A reader that sees `latest.json` pointing to a snapshot that doesn't yet exist gets a 404. **Action:** The classifier must handle this with retry logic (see action item below).

### Inline Duplication

The issue/PR query logic in the collector duplicates patterns from `triage-handler.ts`. This is acceptable for now. Consolidate into a shared `github-client.ts` helper when a third component needs the same queries.

---

## Alternatives Considered

1. **GitHub webhooks (push model):**
   - ✅ Eliminates polling latency, reduces API calls
   - ❌ Requires stateful incremental accumulation, out-of-order event handling, webhook infrastructure
   - **Decision:** Rejected at this stage; revisit when polling becomes cost-prohibitive

2. **1-minute polling:**
   - ✅ Near-real-time failure detection
   - ❌ 4× API call volume for marginal freshness improvement
   - **Decision:** Rejected; overkill for the unblocker's use case

3. **DynamoDB as snapshot store:**
   - ✅ Queryable, structured
   - ❌ More expensive than S3, less human-readable for debugging
   - **Decision:** Rejected; S3 JSON sufficient for sequential read pattern

---

## Action Items

- [x] Document rate-limit analysis in this ADR
- [x] Add S3 lifecycle policy: expire `unblocker/snapshots/` objects older than 30 days
- [x] Document scale trigger (500 concurrent tasks) in code comments and related PRs
- [x] Add retry logic in classifier for `latest.json` eventual-consistency window
- [x] Document polling cadence review trigger (100 concurrent active tasks) as a future decision point

## Future Decision Points (Operations Checklist)

### At 100 Concurrent Active Tasks
- Review current API call volume per collector run
- Verify S3 write performance (expected <5 seconds per snapshot)
- Assess cost vs. accuracy trade-off of 15-minute cadence
- No action required unless performance degrades

### At 500 Concurrent Active Tasks (Scale Trigger)
- **Required decision:** Migrate from polling to webhook-driven incremental model
- Audit API rate-limit consumption (expect to reach ~40% of budget at this scale)
- Design stateful event accumulation pipeline
- Implement out-of-order event handling and deduplication
- Update this ADR with new design

---

## Implementation Notes

### S3 Lifecycle Policy
The lifecycle rule for the artifacts bucket now includes:
- **Prefix:** `unblocker/snapshots/`
- **Expiration:** 30 days
- **Rationale:** Keeps cost down, retains enough history for debugging, prevents indefinite accumulation

### Classifier Retry Logic
The classifier (when implemented) should:
1. Attempt to load `latest.json` from S3
2. If 404 encountered, retry with exponential backoff (max 3 attempts, 100ms base delay)
3. If still not found after retries, fall back to scanning the `unblocker/snapshots/` directory for the most recent snapshot

### Future Scale Review
When fleet monitoring detects 100+ concurrent active tasks, schedule a review meeting to:
1. Audit current API call volume per collector run
2. Forecast API cost at scale
3. Evaluate migration to webhook-driven incremental model
4. Adjust polling cadence if cost-effective

---

## Related Documentation

- `SCHEMA.md`: Snapshot structure and field definitions
- `collector.ts`: Implementation of the failure-graph collector Lambda
- Issue #316: Unblocker handler epic
- Issue #385: Original failure-graph collector design discussion
