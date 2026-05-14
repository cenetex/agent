# Persona Templates

Composable agent definitions. Each YAML file defines a **role** the cenetex/agent system can dispatch as.

When an issue is labeled `agent` AND `role:<persona-id>`, the dispatcher loads the matching `<persona-id>.yaml` and configures the Fargate task with that persona's prompt, tool allowlist, source-repo scope, and (eventually) IAM role.

Without a `role:` label, the agent falls back to the default coding-agent behavior (existing flow).

## Schema

```yaml
id: <persona-id>             # matches role:<id> label, e.g. cab-marcus
display_name: "Marcus — SRE Lead"
board: cab | arb | cto | board | engineering | ...

# Behavior
prompt_file: cab-marcus.md   # the system prompt; markdown, in same directory
output:
  type: comment              # how the persona delivers its work
  target_repo: cenetex/governance
  target_issue: 57           # post comments on this issue

# Capabilities — what tools the persona may invoke
tools:
  bash: true                 # allows gh, aws, etc. (currently all-or-nothing)
  read: true
  grep: true
  glob: true
  edit: false                # this persona does not edit code
  write: false               # this persona does not write new files

# Source access — repos the persona may read/write
sources:
  read:
    - cenetex/aws-swarm
    - cenetex/agent
    - cenetex/governance
  write:
    - cenetex/governance     # only post comments here

# Cloud access (future — not enforced in v1)
aws:
  iam_role: arn:aws:iam::ACCOUNT:role/governance-cab-sre
  permissions:
    - cloudwatch:GetMetricStatistics
    - cloudwatch:DescribeAlarms

# External integrations (future)
mcp_connectors: []
```

## How dispatch works

1. Issue labeled `agent` + `role:cab-marcus`
2. Webhook handler (`infra/lib/webhook-handler.ts`) reads `role:` label and loads `agent/agents/governance/cab-marcus.yaml`
3. Persona profile is embedded in the TaskPayload alongside the issue metadata
4. Fargate container's `entrypoint.sh` detects the persona profile and:
   - Replaces the default mission prompt with `prompt_file` content
   - Restricts Claude Code's tool allowlist to `tools.*`
   - Posts output to `output.target_repo#output.target_issue` instead of the trigger issue
5. Trigger issue gets `agent:succeeded` label and closes; the comment lands on the target issue

## Adding a new persona

1. Create `<id>.yaml` and `<id>.md` (system prompt) in the appropriate subdirectory
2. Add the `role:<id>` label to the target repo(s)
3. Test by labeling a trigger issue with `agent` + `role:<id>`

## Migration notes

These personas were previously implemented as Anthropic Cloud (CCR) remote routines via `RemoteTrigger`. Migration to this Fargate-based system is tracked in cenetex/agent#395. The CCR routines remain active during the transition.
