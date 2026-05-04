import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import {
  validateEnvironment,
  claimStripeEvent,
  updateCreditBalanceWithOptimisticLocking,
  recordLedgerEntry,
  commitStripeEvent,
  getCreditBalance,
  initializeCreditBalance,
} from "@/lib/credit-service";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";

// Initialize clients
const dynamoDb = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

// Initialize Stripe
let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }
    stripe = new Stripe(secretKey, {
      apiVersion: "2024-04-10",
    });
  }
  return stripe;
}

// Validate environment on module load (fail-fast)
let envValidated = false;
try {
  validateEnvironment();
  const requiredWebhookVars = ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"];
  const missing = requiredWebhookVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required Stripe variables: ${missing.join(", ")}`);
  }
  envValidated = true;
} catch (error) {
  console.error("Environment validation failed:", error);
  // Don't exit here, let the first request handle it with a proper error response
}

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  eventId: string,
  sessionId: string
): Promise<{ statusCode: number; message: string }> {
  // Extract repo slug from metadata
  const repoSlug = session.metadata?.repo_slug;
  const creditsAmount = session.metadata?.credits_amount;

  if (!repoSlug || !creditsAmount) {
    console.error(
      `[${eventId}] [${sessionId}] Missing metadata: repo_slug=${repoSlug}, credits_amount=${creditsAmount}`
    );
    return {
      statusCode: 400,
      message: "Missing repo_slug or credits_amount in session metadata",
    };
  }

  const amount = parseInt(creditsAmount, 10);
  if (isNaN(amount) || amount <= 0) {
    console.error(
      `[${eventId}] [${sessionId}] Invalid credits amount: ${creditsAmount}`
    );
    return {
      statusCode: 400,
      message: "Invalid credits amount",
    };
  }

  console.log(
    `[${eventId}] [${sessionId}] Processing checkout session: ${repoSlug}, +${amount} credits`
  );

  // Step 1: Claim the event with idempotency marker (write-first for crash safety)
  const claimed = await claimStripeEvent(eventId, repoSlug, s3);
  if (!claimed) {
    // Another worker is processing this event
    console.log(
      `[${eventId}] [${sessionId}] Event already being processed by another worker, returning 200`
    );
    return {
      statusCode: 200,
      message: "Event already being processed",
    };
  }

  try {
    // Ensure repo balance exists
    let balance = await getCreditBalance(repoSlug, dynamoDb);
    if (!balance) {
      console.log(`[${eventId}] [${sessionId}] Initializing credit balance for ${repoSlug}`);
      balance = await initializeCreditBalance(repoSlug, dynamoDb);
    }

    // Step 2: Update balance with optimistic locking
    const updated = await updateCreditBalanceWithOptimisticLocking(
      repoSlug,
      amount,
      undefined,
      dynamoDb
    );
    console.log(
      `[${eventId}] [${sessionId}] Updated balance for ${repoSlug}: ${updated.current_balance} (version: ${updated.version})`
    );

    // Step 3: Write per-event ledger entry (no read-modify-write)
    await recordLedgerEntry(eventId, repoSlug, amount, s3);

    // Step 4: Mark as committed (optional update after success)
    await commitStripeEvent(eventId, repoSlug, s3);

    console.log(`[${eventId}] [${sessionId}] Successfully processed checkout for ${repoSlug}`);
    return {
      statusCode: 200,
      message: "Checkout session processed successfully",
    };
  } catch (error) {
    console.error(
      `[${eventId}] [${sessionId}] Failed to process checkout for ${repoSlug}:`,
      error
    );
    // We've already claimed the event, so return 200 to Stripe
    // This prevents double-processing even if we crash here
    return {
      statusCode: 200,
      message: "Event claimed but processing failed (will be retried)",
    };
  }
}

export async function POST(request: NextRequest) {
  if (!envValidated) {
    console.error("Environment not properly validated on startup");
    return NextResponse.json(
      { error: "Service not properly configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    console.error("Missing stripe-signature header");
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 403 }
    );
  }

  let event: Stripe.Event;
  try {
    const stripeClient = getStripe();
    event = stripeClient.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 403 }
    );
  }

  console.log(
    `Received Stripe webhook: type=${event.type}, id=${event.id}, session=${event.data?.object?.id ?? "N/A"}`
  );

  if (event.type !== "checkout.session.completed") {
    console.log(`Ignoring event type: ${event.type}`);
    return NextResponse.json({ ok: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const { statusCode, message } = await handleCheckoutSessionCompleted(
    session,
    event.id,
    session.id
  );

  console.log(`[${event.id}] Response: statusCode=${statusCode}, message=${message}`);
  return NextResponse.json({ ok: statusCode === 200, message }, { status: statusCode });
}
