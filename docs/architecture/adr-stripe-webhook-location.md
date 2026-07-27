# ADR: Stripe Webhook Location — Vercel vs Lambda

**Date:** 2026-07-27
**Status:** Accepted
**Decision:** Lambda (separate Lambda + API Gateway route)
**Supersedes:** N/A
**Related issues:** #408, #210

## Context

The agent needs to accept Stripe webhook events for credit purchases and write
them to the S3 credit ledger. Two deployment locations were considered:

1. **Vercel-hosted Next.js app** — a new API route in `website/app/api/`
2. **Existing webhook Lambda** — a new route in the CDK stack's API Gateway

The Vercel route is simpler to ship and was proposed as a quick path to MVP in
sub-issue #4. The Lambda route is operationally cleaner because all credit-
balance writes already go through the same Lambda infrastructure.

## Decision Drivers

- **Single source of truth for credit writes** — the 2026-04-26 credit-
  exhaustion incident showed how visible credit issues are. Two paths writing
  to the same S3 ledger creates a dual-write risk.
- **Operational consistency** — all credit operations should be auditable in
  one place (CloudWatch).
- **Infrastructure reuse** — the existing webhook Lambda already has IAM-
  bounded S3 access and the credit-write helpers.
- **Deployment atomicity** — Lambda deployments are atomic and versioned;
  Vercel can lose state during a redeploy.

## Considered Options

### Option A: Vercel Next.js API route

**Pros:**
- Simpler to ship (sub-issue #4 quick path)
- No new infrastructure to provision
- Co-located with the website

**Cons:**
- Introduces a second write path to the S3 credit ledger (dual-write risk)
- Credit operations split across CloudWatch + Vercel logs
- Vercel can lose state during a redeploy; no atomic deployment guarantee
- Requires separate IAM credentials for S3 access from the Vercel runtime
- Diverges from the existing credit-write code path

### Option B: Lambda (existing webhook handler, new route)

**Pros:**
- All credit-balance writes go through the same Lambda code path
- One audit trail: CloudWatch logs all credit operations in one place
- IAM-bounded S3 access already configured
- Lambda deployments are atomic + versioned
- Reuses existing `recordTransaction`, `initializeCreditBalance`, and balance
  update helpers

**Cons:**
- Slightly more infrastructure to maintain (API Gateway route)
- Coupled to the GitHub webhook handler's deployment cycle

### Option C: Lambda (separate Lambda + API Gateway route)

**Pros:**
- All benefits of Option B
- Cleaner blast radius: Stripe webhook failures don't affect GitHub webhook
  processing and vice versa
- Independent scaling and timeout configuration
- Separate CloudWatch log group for Stripe events
- Still reuses the same S3 credit-ledger helpers via a shared module

**Cons:**
- One additional Lambda function to maintain
- Slight duplication of SSM/IAM boilerplate

## Decision

**Chosen: Option C — separate Lambda + API Gateway route.**

A new `StripeWebhookHandler` Lambda (`infra/lib/stripe-webhook-handler.ts`)
handles `POST /webhooks/stripe` via the existing API Gateway HTTP API. It
reuses the S3 credit-write helpers through a shared `credit-ledger` module
(`infra/lib/credit-ledger.ts`) extracted from the GitHub webhook handler.

This keeps concerns separated (cleaner blast radius) while ensuring a single
source of truth for credit-balance writes. The Vercel route from sub-issue #4
should either not exist or return `410 Gone`.

## Consequences

- **Positive:** Single source of truth for Stripe-originated credit writes;
  no dual-write risk. All credit operations logged in CloudWatch. Clean
  separation between GitHub and Stripe webhook processing.
- **Positive:** Shared `credit-ledger` module eliminates code duplication
  between the GitHub and Stripe webhook handlers.
- **Negative:** One additional Lambda function and API Gateway route to
  maintain.
- **Negative:** Stripe webhook secret must be stored in SSM Parameter Store
  (`/github-agent/STRIPE_WEBHOOK_SECRET`).
- **Mitigation:** The shared module keeps the credit-write logic DRY; the
  SSM parameter follows the existing pattern for webhook secrets.

## Implementation Notes

- **Shared module:** `infra/lib/credit-ledger.ts` exports `initializeCreditBalance`,
  `getCreditBalance`, `recordTransaction`, `addCredits`, `deductCredits`, and
  `checkCreditsAvailable`. Both webhook handlers import from this module.
- **Stripe signature verification:** The Stripe webhook handler verifies the
  `Stripe-Signature` header using the Stripe webhook signing secret from SSM.
- **Event handling:** Only `checkout.session.completed` events are processed.
  The checkout session metadata must include `repo_slug` and `credits`.
- **Optimistic locking:** `addCredits` uses the `version` field for optimistic
  locking to prevent concurrent modification issues.
- **Vercel route:** If a Vercel Stripe webhook route exists from sub-issue #4,
  it must be removed or return `410 Gone` to ensure the Lambda is the single
  source of truth.
- **Stripe dashboard:** The Stripe webhook endpoint must be configured to
  point at the Lambda URL only: `{apiEndpoint}/webhooks/stripe`.
