# Agent Runtime Configuration

This document describes the runtime configuration for the agent task container
(`agent/entrypoint.sh`) and the review container (`agent/review-entrypoint.sh`).

## max_tokens cap (per-request)

The runtime caps `max_tokens` on every model call to prevent OpenRouter 402
rejections mid-stream. Without a cap, the model-default ceiling (e.g. Sonnet's
~32k) can exceed what the OpenRouter balance can afford, causing the agent to
exit 1 even when the actual completion would have been a tiny fraction of the
cap.

### How the cap is computed

```
applied_max_tokens = min(configured_cap, affordable_max_tokens - safety_margin)
```

Where:

- **configured_cap** — the per-model default cap, or a per-task override
- **affordable_max_tokens** — estimated from the OpenRouter balance at dispatch
- **safety_margin** — 256 tokens, to avoid edge-case 402 from rounding

### Per-model defaults

These defaults are **conservative caps, not generous ceilings**. They are
intentionally lower than the model's theoretical maximum to ensure a
thin-but-positive budget still ships PRs.

| Model family | Default cap |
| --- | --- |
| haiku | 4,096 (4k) |
| sonnet | 8,192 (8k) |
| opus | 16,384 (16k) |
| default | 8,192 (8k) |

### Per-task override

A task can override the default cap via `.github/AGENT.md` in the target
repository:

```
max_tokens: 16384
```

This is useful for tasks that legitimately need more headroom (e.g. large
refactor surveys). The override is honored only while the OpenRouter balance
can afford it — if the affordable ceiling is lower than the override, the
runtime reduces the cap to the affordable level (minus safety margin) rather
than 402'ing.

### Telemetry

Every model call logs a telemetry line:

```
[max_tokens] model=$M requested_max=$N affordable_max=$A applied_max=$X
```

This appears in the agent log artifact, so the next time a 402 happens we have
the data to diagnose it.

### Fargate env passthrough

The orchestrator (`infra/lib/webhook-handler.ts`) reads `max_tokens` from
`.github/AGENT.md` and stamps it into the task payload. The runtime container
extracts it from `TASK_PAYLOAD` and uses it as the `configured_cap`. The
`MODEL_MAX_OUTPUT_TOKENS` environment variable is also passed through the
Fargate container overrides for the Codex executor.

### Review container

The review container (`agent/review-entrypoint.sh`) applies the same cap
mechanism. It defaults to 8,192 tokens (GLM 5.2 / sonnet-tier pricing) and can
be overridden via the `MODEL_MAX_OUTPUT_TOKENS` environment variable.
