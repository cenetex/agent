# Credit Admin CLI

A command-line tool for managing GitHub Agent credits. Provides balance checking, top-ups, transfers, and transaction history tracking.

## GitHub App Permission Audit

The agent reads both legacy commit statuses and GitHub Actions check-runs when
deciding whether main is healthy and whether a failed PR should be retried. The
GitHub App therefore needs `statuses:read` and `checks:read` in addition to its
write permissions for contents, issues, pull requests, and workflows.

```bash
./scripts/audit-github-app-permissions.sh atimics/AutoForwarder
```

The script reads the app ID and private key from SSM, checks the live app
permission set, and optionally verifies that the installation token can call the
status and check-run endpoints for the target repository.

## Setup

```bash
cd scripts
npm install
npm run build
```

Or just run the wrapper script (it will auto-rebuild if needed):

```bash
./scripts/credits --help
```

## Usage

### Prerequisites

- AWS credentials configured (via `~/.aws/credentials`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, or IAM role)
- `ARTIFACTS_BUCKET` environment variable set (defaults to bucket from CLAUDE.md)

### Commands

#### Balance

Check credit balance for one repo or all repos.

```bash
# Check balance for a specific repo
./scripts/credits balance --repo cenetex/aws-swarm

# Check all repos
./scripts/credits balance --all
```

Output:
```
cenetex/aws-swarm             500 credits (652 purchased, 252 spent)
cenetex/agent                 500 credits (696 purchased, 296 spent)
cenetex/lab                    72 credits (  0 purchased,  28 spent)
...
Total org:                   1540 credits across 9 repos
```

#### Top Up

Add credits to a repository. Writes to `balance.json` and creates a ledger entry.

```bash
# Top up 200 credits
./scripts/credits topup cenetex/aws-swarm 200

# Top up with a reason
./scripts/credits topup cenetex/aws-swarm 200 --reason "Q1 2026 allocation"
```

Output:
```
✅ Top up successful
Repository: cenetex/aws-swarm
Amount: +200 credits
New balance: 700 credits
```

#### Transfer

Move credits between repos. Updates both balances and creates ledger entries.

```bash
# Transfer 100 credits from kyro to aws-swarm
./scripts/credits transfer cenetex/kyro cenetex/aws-swarm 100
```

Output:
```
✅ Transfer successful
From: cenetex/kyro (100 credits remaining)
To: cenetex/aws-swarm (600 credits now)
Amount: 100 credits
```

#### History

View transaction history for a repo, optionally filtered by month.

```bash
# All transactions
./scripts/credits history cenetex/aws-swarm

# Transactions for a specific month
./scripts/credits history cenetex/aws-swarm --month 2026/03
```

Output:
```
Transaction history for cenetex/aws-swarm (5 transactions):

2026-03-15 10:30:45 CREDIT +100 │ Top up 100 credits
2026-03-20 14:22:10 DEBIT  -12  │ Task: claude-sonnet-4-6 (task_mncdx935_z2bvii)
2026-03-22 09:15:33 CREDIT +50  │ Transfer from cenetex/kyro
2026-03-25 16:45:22 DEBIT  -28  │ Task: claude-opus-4-6 (task_abc123_def456)
2026-03-28 11:20:05 REFUND  +40 │ Refund: task failed (task_xyz789_uvw012)
```

## Data Structure

All credit data is stored in S3 at:
- **Balance**: `s3://{bucket}/credits/{owner}/{repo}/balance.json`
- **Ledger**: `s3://{bucket}/credits/{owner}/{repo}/ledger/{YYYY}/{MM}/transactions.jsonl`

### Balance File Format

```json
{
  "repo_slug": "cenetex/aws-swarm",
  "current_balance": 500,
  "total_purchased": 652,
  "total_spent": 252,
  "last_updated": "2026-03-30T15:45:30.123Z",
  "version": 15
}
```

### Ledger Entry Format (JSONL)

```jsonl
{"timestamp":"2026-03-15T10:30:45.000Z","type":"credit","amount":100,"reason":"Top up 100 credits","task_id":null}
{"timestamp":"2026-03-20T14:22:10.000Z","type":"debit","amount":12,"reason":"Task: claude-sonnet-4-6","task_id":"task_abc123","model":"claude-sonnet-4-6"}
```

## Safety Features

- **Optimistic Locking**: Version field incremented on each update prevents race conditions
- **Immutable Ledger**: All transactions are appended only, never modified
- **Validation**: Amount must be positive, repos must exist
- **Audit Trail**: Every operation logged with timestamp and reason

## Development

```bash
# Build TypeScript
npm run build

# Run CLI (after build)
node dist/credits-admin.js <command> [args]
```

## Future Enhancements

Per the issue, future work includes:
- Org-level credit pool instead of per-repo tracking
- Lambda API endpoint for remote administration
- Integration with GitHub issues (e.g., `/credits topup aws-swarm 200`)
- Advanced reporting and analytics
