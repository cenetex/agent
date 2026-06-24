# Claude Code Configuration

## Project

**cenetex/agent** - GitHub App that automatically handles issues and PRs labeled with `agent`. Runs Claude Code in AWS Fargate to implement features, fix bugs, and review code.

## Architecture

- **Webhook Handler** (`infra/lib/webhook-handler.ts`) - Lambda that listens for GitHub webhook events (issues/PRs labeled `agent`)
- **Agent Container** (`agent/`) - Docker container running Claude Code, spawned in Fargate
- **Infrastructure** (`infra/`) - AWS CDK stack defining Lambda, Fargate, VPC, S3, etc.
- **Credit System** - S3-based billing tracking credits per repository

## Build & Deployment

```bash
# Build infrastructure
cd infra
npm install
npx cdk synth

# Deploy stack
npx cdk deploy GitHubAgentStack

# Register webhooks on other repos (aws-swarm, kyro, ratibot)
./scripts/register-webhooks.sh

# Build and push agent container
cd ../agent
docker build -t $REPO_URI:latest .
docker push $REPO_URI:latest
```

## Key Files

- `infra/lib/webhook-handler.ts` - Main webhook handler (~4,400 lines, handles all GitHub events)
- `infra/lib/stack.ts` - CDK stack definition (Lambda, Fargate, VPC setup)
- `agent/entrypoint.sh` - Wrapper script for Claude Code
- `deploy.sh` - Deployment automation script

## Labels

- `agent` - Trigger label to activate the agent
- `agent:running`, `agent:waiting`, `agent:failed`, `agent:succeeded` - Status labels

## Environment Variables (Set by webhook handler)

- `TASK_PAYLOAD` - JSON task definition
- `GITHUB_TOKEN` - Installation token
- `OPENROUTER_API_KEY` - Model inference API
- `ARTIFACTS_BUCKET` - S3 bucket for task metadata
- `ARTIFACT_PREFIX` - Path prefix in bucket

## Testing

Label an issue with `agent` to trigger a test run. Monitor CloudWatch logs:

```bash
aws logs tail /aws/lambda/GitHubAgentStack-WebhookHandler --follow
```

## Model Configuration

Default models by task type:
- Issues: `claude-haiku-4-5`
- PRs: `claude-sonnet-4-6`
- Planning: `claude-haiku-4-5`

Override with `.github/AGENT.md` in target repo:
```
model: anthropic/claude-opus-4-6
```

## Agent Focus Guardrails

The agent is explicitly instructed to work ONLY on the assigned issue/PR, never drift to related issues. This is enforced in the mission prompt which states:

- For issues: "You are working exclusively on issue #N. Do NOT work on other issues."
- For PRs: "You are reviewing and working exclusively on PR #N. Do NOT work on other PRs or issues."

Related issues, if referenced in the task description, are treated as context only and must not be worked on.
