# Security Architecture

This document describes the isolation boundary and security controls for the GitHub Agent infrastructure.

## Three-Tier Agent Architecture

The agent system implements a tiered architecture where different agents have different permissions based on their role:

### Tier 1: Coding Agent (label: `agent`)

**Permissions:**
- GitHub App token (scoped to installation repositories)
- OpenRouter API key (for Claude model inference)
- S3 read-write access (for task artifacts)

**Trigger:** Any org member labels an issue or PR with `agent`

**Trust Model:** Processes untrusted issue bodies with prompt injection boundary (defense in depth)

**Risk Profile:** Can push code to branches but cannot merge to main

### Tier 2: Review Agent (label: `review`)

**Permissions:**
- Same as Tier 1 + Opus model (higher capability)
- Can approve PRs for auto-merge (with 1-hour hold period before merge)

**Trigger:** Scheduled (every 15 minutes) or manual label

**Trust Model:** Only reads diffs and posts comments; never trusted with hostile input

**Risk Profile:** Can approve PRs but hold period allows human override before merge

### Tier 3: Diagnostic Agent (label: `diagnose`)

**Permissions:**
- Same as Tier 1 + CloudWatch Logs read-only access (scoped to GitHubAgentStack Lambdas only)
- Can read Lambda execution logs for debugging

**Trigger:** Manual label only (org member, human-initiated, never automatic)

**Trust Model:** Can read deployment logs to diagnose failures and verify task execution

**Risk Profile:** Logs may contain accidentally leaked secrets (but should not per proper logging practices)

## Isolation Boundary

The GitHub Agent executes untrusted code in isolated AWS Fargate tasks within a private network environment. The isolation boundary implements defense in depth with network, compute, and identity controls.

### Network Isolation

**Private Network Execution:**
- Agent tasks run in private subnets without public IP addresses
- All inbound access is disabled
- Outbound access is controlled through explicit security group rules and NAT gateway

**Explicit Egress Controls:**
- HTTPS (port 443): GitHub API, model inference, and AWS service APIs
- HTTP (port 80): Package installations and HTTP redirects
- DNS (ports 53 UDP/TCP): Name resolution

**VPC Endpoints:**
- S3 Gateway Endpoint: Private access to artifact storage
- ECR Interface Endpoints: Private container image access
- CloudWatch Logs Interface Endpoint: Private logging
- SSM Interface Endpoint: Private parameter access

### Compute Isolation

**Fargate Task Model:**
- Each agent invocation runs in an isolated Fargate task
- Tasks cannot access other running tasks or persistent storage
- Tasks are ephemeral and destroyed after completion
- Memory and CPU resources are bounded (2048 MiB, 1024 CPU units)

**Task Lifecycle:**
- Task creation is triggered by GitHub webhook events
- Tasks run with least-privilege IAM roles
- Tasks are cleaned up automatically after completion or timeout

### Identity and Access Controls

**IAM Roles:**
- Task execution role: Limited to container lifecycle operations
- Task role: Scoped to required AWS services (S3 artifacts, SSM parameters)
- No persistent credentials or broad AWS access

**GitHub Integration:**
- GitHub App installation tokens provide scoped repository access
- Tokens are short-lived and automatically refreshed
- No persistent GitHub credentials stored in tasks

## Security Boundaries

| Boundary | Control | Purpose |
|----------|---------|---------|
| Network | Private subnets + NAT | Prevent direct internet exposure |
| Egress | Security group rules | Limit outbound connections |
| Compute | Fargate isolation | Prevent task-to-task communication |
| Storage | Ephemeral containers | No persistent state between tasks |
| Identity | Scoped IAM roles | Limit AWS service access |
| Repository | GitHub App tokens | Scope access to specific repositories |

## Threat Model

**Mitigated Threats:**
- ✅ Network-based attacks from internet
- ✅ Task-to-task communication and data exfiltration
- ✅ Persistent compromise of infrastructure
- ✅ Escalation beyond repository scope
- ✅ Abuse of broad AWS permissions

**Residual Risks:**
- ⚠️ Code execution within the repository context (by design)
- ⚠️ Resource consumption within task limits
- ⚠️ Outbound network connections within allowed ports

## Security Rationale for Diagnostic Agent

The diagnostic agent implements the following security controls to safely access CloudWatch Logs:

### IAM Policy Scoping

The diagnostic task role can **ONLY** read logs from Lambdas that match the pattern `/aws/lambda/GitHubAgentStack-*`. This is enforced at the IAM policy level (not the application level) and prevents access to:
- Logs from other services (databases, API gateways, etc.)
- Logs from other applications or infrastructure
- Any AWS resources other than CloudWatch Logs read operations

### Threat Model

**What an attacker with issue-creation access could do:**
- If they achieve org membership, they could label an issue with `diagnose`
- The diagnostic agent would then run and could read GitHubAgentStack Lambda logs
- Those logs contain: webhook payloads, task launch metadata, error messages

**What they CANNOT do:**
- Read logs from other services or AWS resources (IAM policy blocks it)
- Modify or delete logs (read-only permission)
- Access to API keys or secrets (these are stored in SSM Parameter Store, not in logs)
- Run arbitrary AWS CLI commands (task role only has specific CloudWatch Logs permissions)

**Why this is acceptable:**
- Org members already have AWS console access and could read these logs directly
- Logs should not contain secrets or credentials by design (these go to SSM)
- The `diagnose` label is manual (human-initiated), never automatic
- The IAM policy is the hard security boundary, not the application logic

## Operational Security

**Monitoring:**
- CloudWatch logging for all task execution
- GitHub webhook event logging
- VPC Flow Logs for network monitoring

**Incident Response:**
- Task termination capabilities via ECS APIs
- Automated cleanup of stale tasks
- Artifact retention for forensic analysis

**Updates and Maintenance:**
- Container images stored in private ECR repository
- Infrastructure deployed via AWS CDK with version control
- Parameterized secrets management via AWS SSM

## Compliance Notes

This architecture provides baseline isolation suitable for automated code review and implementation tasks on trusted repositories. For handling untrusted or high-risk code, consider additional controls such as:

- Dedicated VPCs per repository or organization
- Additional network segmentation
- Enhanced monitoring and alerting
- Stricter resource quotas and time limits