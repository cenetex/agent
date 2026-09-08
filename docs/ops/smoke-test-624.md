# Operator Smoke Test — Issue #624

**Date:** 2026-09-06
**Operator:** Codex CLI (autonomous, agent class: operator)
**Repository:** cenetex/agent
**Scope:** Read-only inspection of the last 24 hours of the dispatch chain.

## Observed

### Canary — most recent daily dispatch canary

- **Canary commit:** `d0226f3` — "Fixes #620: apply verified agent changes (#621)" — committed 2026-09-06 18:00:34 UTC, author `cenetex[bot]`, co-author `github-agent[bot]`.
- **Canary artifact in repo:** `docs/canary-log.md` created at `d0226f3` with content `canary 2026-09-06`. This is the one-line canary body the canary handler's prompt instructs the agent to append.
- **Canary scheduling:** `infra/lib/stack.ts` defines `CanaryFunction` with an EventBridge `CanaryRule` at cron `30 04 * * *` (4:30 AM UTC daily, before the 9 AM digest).
- **Canary state persistence:** `infra/lib/canary-handler.ts` stores canary state at S3 key `canary/state.json` in `ARTIFACTS_BUCKET` (bucket name pattern `github-agent-artifacts-<account>-<region>`, defined in `stack.ts`).
- **Canary classification logic:** The handler classifies the previous canary issue by labels: `agent:succeeded` → pass; `agent:failed` → fail; closed without `agent:succeeded` → fail; `agent:running` > 120 min stale → fail. On fail it opens or appends to an alert issue titled `🚨 Canary alert: agent dispatch chain broken <date>`, labeled `escalation:queue`.
- **No open canary alert issue** was visible in the repo's issue tracker from the permitted read-only surface (GitHub API is network-blocked from this sandbox; see Unknown).

### QA — most recent nightly QA run

- **QA commit:** `0beb7b8` — "Fixes #616: apply verified agent changes (#622)" — committed 2026-09-06 18:00:50 UTC, author `cenetex[bot]`, co-author `github-agent[bot]`.
- **QA artifact in repo:** `docs/qa/nightly-check-616.md` created at `0beb7b8`. It documents QA issue #616 (dated 2026-09-06) with results:
  - Shell syntax: **[PASS]** — `agent/entrypoint.sh`, `agent/review-entrypoint.sh`, `agent/lib/common.sh`, `agent/lib/lint-loop.sh`, `agent/lib/orchestrate-lint.sh`, `deploy.sh` all passed `bash -n`.
  - TypeScript compilation: **[WARN]** — `npm ci` failed with `EAI_AGAIN` (no network); fallback brace/parenthesis/bracket balance checks passed on all 24 `infra/` TS files.
  - Pre-flight simulation: **[WARN]** — OpenRouter, GitHub API, and `git ls-remote` all blocked by sandbox network restriction.
  - Container dependencies: **[PASS]** — `aws`, `codex`, `jq` all found.
  - Recent changes audit: **[PASS]** — all 27 changed files across the last 10 commits verified on disk.
  - Cost check: **[WARN]** — no AWS credentials; no OpenRouter network.
  - End-to-end smoke test: **[SKIP]** — skipped as risky.
  - Summary: no **[FAIL]** items; all **[WARN]** items are sandbox environment limitations, not code defects.
- **QA scheduling:** `infra/lib/stack.ts` defines `QAFunction` with `QARule` at cron `00 02 * * *` (2:00 AM UTC daily).

### Handler source files (infrastructure)

- **Webhook handler:** `infra/lib/webhook-handler.ts` — receives GitHub webhooks at `/webhook`, dispatches ECS Fargate tasks (`RunTaskCommand`), stores task payload at `s3://<ARTIFACTS_BUCKET>/<artifact_prefix>/payload.json`, stores metadata at `<artifact_prefix>/metadata.json` including `task_arn`. Signal labels: `agent:running`, `agent:waiting`, `agent:failed`, `agent:succeeded`.
- **Task-status handler:** `infra/lib/task-status-handler.ts` — invoked by EventBridge every 15 minutes; reconciles credit reservations, scans for low-credit repos, refunds dispatch-time reservations for failed/timed-out tasks.
- **Canary handler:** `infra/lib/canary-handler.ts` — as described above.
- **Daily-digest handler:** `infra/lib/daily-digest-handler.ts` — invoked at 9 AM UTC; collects task metadata from the past 24 hours from `s3://<ARTIFACTS_BUCKET>/tasks/<repo_slug>/<task_id>/metadata.json`, posts an "Agent Daily Digest" issue labeled `bot-summary, automated`.

### ECS task state

- The webhook handler launches ECS Fargate tasks via `RunTaskCommand` and records the returned `taskArn` in `TaskMetadata.task_arn`. The task ARN format is `arn:aws:ecs:<region>:<account>:task/<cluster>/<task-id>`.
- The canary task specifically: the canary dispatches a GitHub issue labeled `agent`, which flows through the normal webhook → Fargate path. The resulting ECS task ARN would be stored in `s3://<ARTIFACTS_BUCKET>/tasks/cenetex/agent/<task_id>/metadata.json`. No task ARN was directly observable from this sandbox (no AWS credentials; see Unknown).

### S3 task metadata and artifact prefixes

- **Canary state:** `s3://<ARTIFACTS_BUCKET>/canary/state.json` — contains `{ issue_number, dispatched_at }`.
- **Task metadata:** `s3://<ARTIFACTS_BUCKET>/tasks/<owner>/<repo>/<task_id>/metadata.json` — fields include `task_id`, `repo_slug`, `issue_number`, `task_mode`, `agent_class`, `status`, `resolved_commit_sha`, `task_arn`, `artifact_prefix`, `created_at`, `started_at`, `completed_at`, `model`.
- **Task artifacts:** `tasks/<repo_slug>/<task_id>/{metadata.json, payload.json, agent.log, summary.md, manifest.json}`.
- **Credit artifacts:** `credits/<repo_slug>/balance.json` and `credits/<repo_slug>/ledger/<YYYY-MM>.jsonl`.
- **Artifacts bucket name:** `github-agent-artifacts-<account>-<region>` (CDK `bucketName` pattern, `stack.ts`).
- Bucket lifecycle: 30-day expiration on artifacts; no versioning.

## Verified

These facts are confirmed by two independent sources (source code + git history, or two code paths):

- The canary ran on 2026-09-06 and produced a real commit. Confirmed by: (1) `docs/canary-log.md` content `canary 2026-09-06` and (2) commit `d0226f3` at 18:00:34 UTC adding that file — the canary prompt instructs appending `canary <current UTC date>`.
- The QA nightly ran on 2026-09-06 and produced a real report. Confirmed by: (1) `docs/qa/nightly-check-616.md` documenting QA issue #616 and (2) commit `0beb7b8` at 18:00:50 UTC adding that file.
- The canary handler dispatches through the normal `agent`-label webhook path (not a special bypass). Confirmed by: (1) `canary-handler.ts` `dispatchCanary()` creates an issue with `labels: ["agent"]` and (2) `webhook-handler.ts` treats the `agent` label as the trigger label.
- The artifact prefix pattern is `tasks/<owner>/<repo>/<task_id>/`. Confirmed by: (1) `createArtifactPrefix()` in `types.ts` and (2) the daily-digest handler's S3 listing logic that parses `key.split('/')` expecting `tasks/{owner}/{repo}/{taskId}/metadata.json`.
- The canary schedule is 4:30 AM UTC and the QA schedule is 2:00 AM UTC. Confirmed by: (1) `stack.ts` `CanaryRule` cron `{minute: "30", hour: "4"}` and (2) `QARule` cron `{minute: "0", hour: "2"}`.

## Suspected

- **The canary likely succeeded today.** The canary prompt instructs the agent to append one line to `docs/canary-log.md` and open a PR. The file exists with exactly `canary 2026-09-06`, matching the expected format, and commit `d0226f3` ("Fixes #620") merged it via PR #621. The canary handler classifies `agent:succeeded` as a pass — if issue #620 was labeled `agent:succeeded`, the canary passed. (Hypothesis: cannot confirm the label without GitHub API access.)
- **The QA nightly passed with no FAIL items.** The QA report explicitly states "No [FAIL] items — no new issues to create" and all [WARN] items are attributed to sandbox network restrictions, not code defects. (Hypothesis: the report is self-consistent but was authored by the agent in a constrained sandbox, so the [WARN] items may not reflect the live environment.)
- **The dispatch chain is healthy end-to-end.** Both the canary and QA produced verified commits through the full path (webhook → Fargate → auth → model → tool execution → PR → merge), which is precisely what the canary is designed to prove. (Hypothesis: the absence of an open alert issue would confirm this, but cannot be verified without GitHub API access.)

## Unknown

- **CloudWatch logs** for the webhook handler, task-status handler, canary handler, and daily-digest handler. No AWS credentials are available in this sandbox (`NoCredentials`); CloudWatch Logs cannot be queried. Live log streams and Lambda invocation counts are not observable.
- **ECS task state** for the canary task. The task ARN is discoverable in principle (stored in S3 metadata under `task_arn`), but S3 is not accessible without AWS credentials. `aws describe-tasks` could not be run.
- **S3 bucket contents** — `canary/state.json`, task metadata objects, artifact prefixes. The bucket name and key structure are known from code, but actual object listing requires S3 API access.
- **GitHub issue labels and statuses** for issues #620 (canary) and #616 (QA). GitHub API is network-blocked from this sandbox (`Could not resolve host: api.github.com`). The presence or absence of an open canary alert issue could not be confirmed.
- **Live Lambda invocation history** — whether the canary and QA Lambda functions actually fired at their scheduled times today. The committed artifacts prove the downstream effect, but the EventBridge → Lambda invocation itself is not directly observable from this surface.
- **OpenRouter credits and model usage** — the `/auth/key` endpoint is network-blocked; no API key is available.

## Recommended next action

Re-run this smoke test from an environment with AWS credentials and GitHub API access (or grant the operator a read-only IAM role + GitHub token) to close the Unknown gaps — specifically: query CloudWatch Logs for the four handler invocations, list `s3://github-agent-artifacts-*/canary/state.json`, and confirm issue #620's labels on GitHub. No infrastructure change is needed; the chain appears healthy from all observable evidence.
