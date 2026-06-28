# GitHub Agent Architecture

This document maps the deployed agent system: the webhook control plane, custom
executor runtime tasks, scheduled operators, review/merge gates, and artifact stores.

## System Overview

```mermaid
flowchart TD
  GitHub["GitHub App<br/>issues, PRs, labels, checks, webhooks"] --> Api["API Gateway<br/>/webhook"]
  Api --> Webhook["Webhook Handler Lambda"]

  Webhook -->|agent label| AgentTask["Agent ECS Task<br/>custom executor + GLM 5.2"]
  Webhook -->|diagnose label| DiagnosticTask["Diagnostic ECS Task<br/>read-only CloudWatch access"]
  Webhook -->|bot PR opened or agent:succeeded| ReviewTask["Review ECS Task<br/>Codex CLI + GLM 5.2"]

  AgentTask --> PullRequest["Bot branch + PR"]
  ReviewTask --> ReviewLabels["review labels<br/>review:approved<br/>review:changes-requested<br/>review:human-required"]
  ReviewLabels --> MergeTriage["Merge Triage Handler<br/>queue plan + safe auto-merge"]

  subgraph Scheduled["EventBridge scheduled operators"]
    ReviewSweep["Review Handler<br/>every 15 min"]
    MergeSweep["Merge Triage<br/>every 15 min"]
    Cleanup["Cleanup/Reaper<br/>every 2 hr"]
    DailyDigest["Daily Digest<br/>09:00 UTC"]
    CreditRescan["Credit Rescan<br/>hourly"]
    QA["QA Trigger<br/>02:00 UTC"]
    Escalation["Escalation Handler<br/>every 15 min"]
    TaskStatus["Task Status Monitor<br/>every 30 min"]
    Grooming["Issue Grooming<br/>every 15 min"]
    Triage["Auto-Triage<br/>every 15 min"]
    Unblocker["Unblocker Collector<br/>every 15 min"]
  end

  ReviewSweep --> ReviewTask
  MergeSweep --> MergeTriage
  MergeTriage --> GitHub
  Cleanup --> GitHub
  CreditRescan --> GitHub
  QA --> GitHub
  Escalation --> GitHub
  TaskStatus --> GitHub
  Grooming --> GitHub
  Triage --> GitHub

  SSM["SSM Parameter Store<br/>GitHub App key, webhook secret,<br/>OpenRouter key, optional social tokens"] --> Webhook
  SSM --> Scheduled
  SSM --> AgentTask
  SSM --> ReviewTask

  S3["S3 artifacts bucket<br/>task metadata, logs, review payloads,<br/>credits, escalation queues"] <--> Webhook
  S3 <--> AgentTask
  S3 <--> ReviewTask
  S3 <--> MergeTriage
  S3 <--> Scheduled

  CloudWatch["CloudWatch Logs"] <-->|logs| AgentTask
  CloudWatch <-->|logs| ReviewTask
  CloudWatch <-->|logs| DiagnosticTask
```

## Issue-To-PR Flow

```mermaid
flowchart TD
  Issue["Issue labeled agent"] --> Webhook["Webhook Handler"]
  Webhook --> DispatchGates["Dispatch gates<br/>capacity, credits, dependencies,<br/>main CI health, labels"]
  DispatchGates -->|ready| AgentTask["Agent ECS Task"]
  DispatchGates -->|capacity full| Queued["agent:queued"]
  DispatchGates -->|blocked| Blocked["status:blocked or blocked:main-broken"]

  AgentTask --> Executor["agent-executor<br/>OpenRouter z-ai/glm-5.2"]
  Executor --> Branch["Feature branch + commit"]
  Branch --> PR["Pull request"]
  PR --> CIPoll["Agent CI poll"]

  CIPoll -->|checks green| Succeeded["agent:succeeded"]
  CIPoll -->|checks unreadable| Succeeded
  CIPoll -->|checks pending timeout| Waiting["agent:waiting"]
  CIPoll -->|PR failure| Retry["retry agent once"]

  Succeeded --> ReviewStart["Immediate review trigger"]
  ReviewStart --> ReviewPayload["Upload review payload to S3"]
  ReviewPayload --> ReviewTask["Review ECS Task"]
  ReviewTask --> ReviewDecision["review:* labels + comment"]
```

## Review And Merge Gate

```mermaid
stateDiagram-v2
  [*] --> OpenPR

  OpenPR --> ReviewNeeded: bot PR without review label
  ReviewNeeded --> ReviewRunning: review:in-progress
  ReviewRunning --> ChangesRequested: review:changes-requested
  ReviewRunning --> HumanRequired: review:human-required
  ReviewRunning --> Approved: review:approved

  Approved --> WaitingForHuman: no current human approval
  Approved --> HoldPeriod: current human approval exists
  HoldPeriod --> MergeTriage: hold elapsed

  MergeTriage --> MergeReady: CI green, mergeable, first safe slot
  MergeTriage --> MergeQueued: overlaps another ready PR or queue cap reached
  MergeTriage --> ConflictHandling: merge conflict
  MergeTriage --> StaleBranch: branch behind base
  MergeTriage --> Paused: pause-agent or human-required

  StaleBranch --> MergeTriage: update branch requested
  ConflictHandling --> MergeReady: update branch succeeds
  ConflictHandling --> ConflictIssue: update branch fails
  MergeQueued --> MergeTriage: next scheduled pass

  MergeReady --> Merged: auto-merge
  ChangesRequested --> AgentFollowup: re-label agent if fixes are wanted

  Merged --> [*]
  HumanRequired --> [*]
  WaitingForHuman --> [*]
  Paused --> [*]
  ConflictIssue --> [*]
  AgentFollowup --> [*]
```

## Runtime Components

| Component | File | Purpose |
| --- | --- | --- |
| CDK stack | `infra/lib/stack.ts` | Defines VPC, ECS, ECR, S3, API Gateway, Lambdas, EventBridge rules, and shared monitored repo configuration. |
| Webhook handler | `infra/lib/webhook-handler.ts` | Handles GitHub events, dispatches agent/diagnostic/review tasks, checks gates, processes PR lifecycle events. |
| Agent container | `agent/entrypoint.sh` | Runs the custom executor for issues and PR work, creates branches/PRs, polls CI, writes task artifacts, updates labels. |
| Review container | `agent/review-entrypoint.sh` | Loads review payloads, runs Codex review analysis, posts feedback, applies review labels. |
| Review handler | `infra/lib/review-handler.ts` | Scheduled review sweep that launches review tasks for coding-agent PRs. |
| Merge triage handler | `infra/lib/merge-triage-handler.ts` | Scheduled merge queue planner; labels merge readiness, stores queue snapshots, updates stale branches, and auto-merges one safe PR per repo pass. |
| Merge triage policy | `infra/lib/merge-triage-policy.ts` | Deterministic queue policy for hold-period, approval, overlap, conflict, and risk decisions. |
| Triage handler | `infra/lib/triage-handler.ts` | Labels and sizes open issues; can split or flag work that is too broad. |
| Grooming handler | `infra/lib/grooming-handler.ts` | Enforces issue-shape and acceptance-criteria limits. |
| Cleanup handler | `infra/lib/cleanup-handler.ts` | Reaps stale tasks, retries recoverable failures, refunds timed-out runs, drains queued work. |
| Task status handler | `infra/lib/task-status-handler.ts` | Periodic health checks for running tasks and escalation triggers. |
| Escalation handler | `infra/lib/escalation-handler.ts` | Maintains the human-attention queue. |
| Credit rescan | `infra/lib/credit-rescan-handler.ts` | Rechecks blocked issues when credits are available again. |
| Daily digest | `infra/lib/daily-digest-handler.ts` | Publishes daily activity and credit summaries. |
| QA trigger | `infra/lib/qa-trigger.ts` | Creates nightly QA work. |
| Unblocker collector | `infra/lib/unblocker/collector.ts` | Captures failure graph snapshots and metrics. |

## Operational Contracts

- The trigger label is `agent`; status labels are `agent:running`,
  `agent:queued`, `agent:waiting`, `agent:failed`, and `agent:succeeded`.
- Review tasks consume `REVIEW_PAYLOAD_S3_KEY`; inline `REVIEW_PAYLOAD` remains
  as a rolling-deploy fallback.
- Immediate and scheduled review launches both add `review:in-progress` to avoid
  duplicate review tasks.
- CI visibility failures from missing GitHub App scopes are not treated as
  pending CI inside the agent task. They mark the coding work as complete and
  defer final safety to review and branch protection.
- Merge triage applies exactly one `merge:*` label to tracked coding-agent PRs:
  `merge:ready`, `merge:queued`, `merge:waiting`, `merge:blocked`,
  `merge:conflict`, or `merge:stale`.
- Merge requires `review:approved`, no blocking labels, elapsed hold period, an
  open and mergeable PR, a current human approval, no protected paths, and the
  first safe merge slot for the PR's overlapping file group.
- Merge triage merges at most one ready PR per repository per scheduled pass,
  then rechecks the remaining queue after GitHub updates the base branch.
- Merge triage writes the latest plan to
  `merge-triage/<owner>/<repo>/latest.json` in the artifacts bucket.
- Protected paths such as workflows, infra, secrets, keys, and deploy scripts
  force `review:human-required`.

## Required GitHub App Permissions

The control plane requires these repository permissions:

- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Workflows: read/write
- Commit statuses: read-only
- Checks: read-only
- Metadata: read-only

After changing app permissions, the repository or organization owner must
approve the updated installation before new installation tokens receive those
scopes.
