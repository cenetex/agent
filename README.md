# GitHub Agent

An AI developer for GitHub. It takes an issue or pull request, makes the change
on a branch, opens or updates a pull request, waits for normal CI, and merges the
green result. A merge to `main` deploys the service automatically.

## Quick start

1. Add the `agent` label to an issue or pull request.
2. The agent changes the label to `agent:running` and starts work.
3. For an issue, it creates a branch and pull request. For a pull request, it
   updates the existing branch.
4. It waits for CI.
5. If CI is green and GitHub accepts the merge, it squash-merges the pull
   request. If GitHub refuses, the pull request stays open and the issue changes
   to `agent:waiting` with the reason.

No second AI review, approval label, protected-file form, hold timer, or custom
merge queue is part of this path.

## Engineering model

The system follows a short contract:

- A clear user request authorizes normal development work.
- Every code change is visible in a branch and pull request.
- Tests, repository rules, and deployment health are the machine checks.
- Agents may create and update pull requests, merge green work, deploy, verify,
  and roll back.
- GitHub is the audit log. Extra evidence bundles and approval labels are not
  required.
- Ask a human only for a decision the agent cannot safely reverse or infer.

The pull request is a useful collaboration surface, not a paperwork gate.

## Live flow

```text
request -> branch -> pull request -> CI -> merge -> deploy -> health check
                                      \
                                       -> leave open with a useful reason
```

Repository rules remain authoritative. The agent never bypasses a failed check
or a merge rejection. It also keeps model workers isolated from GitHub and AWS
credentials; a trusted broker publishes their verified patch.

## Labels

- `agent` starts or resumes work.
- `diagnose` starts a read-only production diagnosis.
- `agent:running` means work is active.
- `agent:waiting` means the agent needs input, green CI, or a merge blocker fixed.
- `agent:failed` means the run failed.
- `agent:succeeded` means the requested work completed.
- `status:blocked` means execution cannot currently start, for example because
  credits are unavailable.

Legacy `review:*` and `merge:*` labels are not required by the live flow.

## Active architecture

- The webhook Lambda receives GitHub App events and launches work.
- The agent Fargate task runs the coding worker and trusted publication broker.
- The diagnostic Fargate task has read-only CloudWatch access.
- CI runs on pull requests and `main`.
- The agent calls GitHub's merge API only after it sees green CI.
- A push to `main` starts the deployment workflow.
- Cleanup, task health, credit, digest, and QA jobs continue to run.

The old scheduled review and merge-triage rules are disabled. Their code remains
temporarily for rollback and can be deleted after the direct flow has run cleanly
in production.

See [docs/architecture.md](./docs/architecture.md) for the component map and
[SECURITY.md](./SECURITY.md) for credential isolation.

## Deployment

The `CI` workflow validates pull requests and pushes to `main`. The `Deploy`
workflow runs on every push to `main` and can also be started manually. It
validates the project, deploys the CDK stack, and publishes the latest agent
image.

The CDK stack uses private subnets by default. For the lower-cost public-subnet
mode, pass `-c usePublicSubnets=true` to CDK.

## Per-repository configuration

Repositories can add `.github/AGENT.md`:

```yaml
model: z-ai/glm-5.2
conventions: |
  - Add tests for behavior changes.
  - Match the existing style.
instructions: |
  Prefer the smallest change that completely solves the request.
```

Configuration should describe how to build the software, not add a parallel
approval process.

## GitHub App permissions

The app needs:

- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Workflows: read/write
- Commit statuses: read-only
- Checks: read-only
- Metadata: read-only

These permissions allow it to publish branches, create pull requests, read CI,
merge accepted changes, and change workflows when requested.

## Local verification

```bash
npm ci
cd infra
npm ci
npm run build
npm test
cd ../agent
npm ci
npm run build
bash -n entrypoint.sh
```

## Troubleshooting

- If work does not start, confirm the GitHub App is installed and the `agent`
  label exists.
- If a green pull request stays open, read the agent comment and GitHub's merge
  status. Repository rules are the final authority.
- If checks cannot be read, grant the App read access to checks and commit
  statuses, then re-add `agent`.
- If a task fails, fix the reported problem and re-add `agent`.
- For runtime failures, add `diagnose` or inspect the webhook and task logs in
  CloudWatch.
