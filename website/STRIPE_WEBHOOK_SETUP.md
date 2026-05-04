# Stripe Webhook Setup Guide

This document describes the infrastructure and configuration needed for the Stripe webhook handler to work correctly.

## DynamoDB Table

Create a DynamoDB table for credit balances with optimistic locking support:

```bash
aws dynamodb create-table \
  --table-name credit-balances \
  --attribute-definitions \
    AttributeName=repo_slug,AttributeType=S \
  --key-schema \
    AttributeName=repo_slug,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

### Table Schema

- **Table Name**: `credit-balances`
- **Primary Key**: `repo_slug` (String)
- **Attributes**:
  - `repo_slug` (String) - Repository identifier (owner/repo)
  - `current_balance` (Number) - Available credits
  - `total_purchased` (Number) - Total credits purchased via Stripe
  - `version` (Number) - Version counter for optimistic locking
  - `last_updated` (String) - ISO 8601 timestamp of last update

### Optimistic Locking

The `version` attribute enables concurrent writes without conflicts:

```typescript
UpdateExpression: "SET current_balance = current_balance + :amount, #version = #version + :one"
ConditionExpression: "attribute_exists(repo_slug)" // Can also check version = :expectedVersion
```

If two concurrent updates happen:
1. Both read the same version (e.g., v2)
2. First update: v2 → v3 ✓
3. Second update attempts: v2 → v3, but current is v3, so ConditionCheckFailed
4. Client retries with exponential backoff; one eventually succeeds and increments to v4

## S3 Bucket Structure

The implementation uses S3 for idempotency markers and ledger:

```
credits/
├── {owner}/{repo}/                    # Per-repo data
│   ├── stripe-events/
│   │   └── {event_id}.json           # Idempotency marker (claim + commit)
│   └── ledger/
│       └── {yyyy}/{mm}/
│           └── {event_id}.json       # Per-event transaction entry
```

### Idempotency Marker (`stripe-events/{event_id}.json`)

```json
{
  "claimed_at": "2026-05-04T12:34:56Z",
  "committed_at": "2026-05-04T12:34:57Z"
}
```

**Claim-Then-Commit Protocol**:
1. Write marker with `IfNoneMatch: "*"` (only if key doesn't exist)
2. On success: proceed with balance update and ledger append
3. On 412 PreconditionFailed: another worker claimed it; return 200 to Stripe
4. After balance update: update marker with `committed_at` timestamp

This ensures:
- Exactly one worker processes each event
- Even if we crash between steps, event is re-attempted (not double-processed)
- No read-modify-write race conditions

### Ledger Entry (`ledger/{yyyy}/{mm}/{event_id}.json`)

```json
{
  "event_id": "evt_1234567890abcdef",
  "amount": 500,
  "timestamp": "2026-05-04T12:34:56Z",
  "type": "stripe_purchase"
}
```

Each event gets its own key (no concurrent read-modify-write of shared .jsonl file).

## Environment Variables

Required for production deployment:

```bash
# AWS Config
AWS_REGION=us-east-1
ARTIFACTS_BUCKET=github-agent-artifacts-account-us-east-1
DYNAMODB_CREDITS_TABLE=credit-balances

# Stripe Config (from https://dashboard.stripe.com/apikeys)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_... # From https://dashboard.stripe.com/webhooks
```

### Validation

The service validates all required environment variables at **startup** (not on first request):

```typescript
// Fails with clear error if any variable is missing
validateEnvironment(); // Called on module load
```

This prevents silent 500 errors on the first webhook.

## Stripe Webhook Configuration

1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://agent.cenetex.com/api/webhooks/stripe`
3. Select events: `checkout.session.completed`
4. Copy webhook secret to `STRIPE_WEBHOOK_SECRET` environment variable

### Session Metadata

Stripe checkout sessions must include metadata for credit processing:

```javascript
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [{ price: 'price_xxxxx', quantity: 1 }],
  mode: 'payment',
  success_url: '...',
  metadata: {
    repo_slug: 'owner/repo',      // Must match DynamoDB key
    credits_amount: '500',         // Positive integer
  },
});
```

## Concurrency Safety: Three Scenarios

### 1. Parallel Webhooks (Same Repo)

Two simultaneous `checkout.session.completed` for the same repo:
- Both claim different event IDs successfully
- Both use DynamoDB's atomic `UpdateExpression` to increment balance
- Version counter ensures both updates land (no lost writes)
- **Result**: Both credits applied ✓

### 2. Duplicate Event (Same Event ID)

Stripe retries the same event (e.g., due to network timeout):
- First delivery: claims event marker with S3 `IfNoneMatch: "*"` → success
- Processing proceeds (balance update, ledger, commit)
- Stripe retry: tries to claim same event → 412 PreconditionFailed
- Handler returns 200 (Stripe satisfied, event not re-processed)
- **Result**: Credit applied exactly once ✓

### 3. Process Crash

Process killed between balance update and marker commit:
- Balance already updated in DynamoDB ✓
- Marker exists (claimed but not committed)
- Stripe retries same event_id
- Handler tries to claim → 412 (already exists) → return 200
- **Result**: No double-credit, event re-attempted is safe ✓

## Testing Locally

1. Set environment variables in `.env.local`:
```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_test_...
DYNAMODB_CREDITS_TABLE=credit-balances-local
AWS_REGION=us-east-1
```

2. Use Stripe CLI for local webhook simulation:
```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# In another terminal, trigger test event:
stripe trigger checkout.session.completed \
  --override checkout.session.metadata.repo_slug=test/repo \
  --override checkout.session.metadata.credits_amount=100
```

## Monitoring and Observability

### Logging

All log lines include correlation IDs for Stripe dashboard lookup:

```
[evt_1234567890abcdef] [cs_test_12345] Processing checkout session: owner/repo, +500 credits
[evt_1234567890abcdef] [cs_test_12345] Updated balance for owner/repo: 2500 (version: 42)
[evt_1234567890abcdef] [cs_test_12345] Successfully processed checkout for owner/repo
```

Use these to correlate with Stripe webhook delivery logs:
- `event.id` links to Stripe Event page
- `session.id` links to Stripe Checkout Session page

### CloudWatch Logs

Deploy with Vercel or Lambda integration to track:
- Webhook processing latency
- Failed events (500 errors)
- Duplicate event detection
- DynamoDB ConditionCheckFailed (retry scenarios)

## Related Issues

- **#418** - Stripe webhook with optimistic locking and idempotency (this implementation)
- **#406** - Original credit purchase feature spec
- **#210** - Credit system epic
