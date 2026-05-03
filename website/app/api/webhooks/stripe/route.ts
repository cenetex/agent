import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import Stripe from "stripe";

export const runtime = "nodejs";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-04-10",
});

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const BUCKET = process.env.ARTIFACTS_BUCKET || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

interface CreditBalance {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
  version: number;
}

interface CreditTransaction {
  timestamp: string;
  type: "credit" | "debit" | "refund";
  amount: number;
  reason: string;
  task_id: string | null;
  stripe_session_id?: string;
}

export async function POST(request: NextRequest) {
  try {
    // Get raw body for signature verification
    const rawBody = await request.arrayBuffer();
    const sig = request.headers.get("stripe-signature");

    if (!sig) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 }
      );
    }

    // Verify signature
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 400 }
      );
    }

    // Handle checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // Extract metadata
      const repoSlug = session.metadata?.repo_slug;
      const creditAmount = session.metadata?.credit_amount;
      const userLogin = session.metadata?.user_login;

      if (!repoSlug || !creditAmount || !userLogin) {
        console.error(
          "Missing metadata in Stripe session",
          session.id
        );
        return NextResponse.json(
          { error: "Missing required metadata" },
          { status: 400 }
        );
      }

      const credits = parseInt(creditAmount, 10);
      if (isNaN(credits) || credits <= 0) {
        return NextResponse.json(
          { error: "Invalid credit amount" },
          { status: 400 }
        );
      }

      // Check if event already processed (idempotency)
      const eventMarkerKey = `credits/${repoSlug}/stripe-events/${event.id}`;
      const isProcessed = await checkEventProcessed(eventMarkerKey);

      if (isProcessed) {
        return NextResponse.json(
          { message: "Event already processed" },
          { status: 200 }
        );
      }

      // Update balance with retry on conflict
      let retries = 0;
      const maxRetries = 3;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          await updateCreditBalance(
            repoSlug,
            credits,
            session.id || ""
          );
          success = true;
        } catch (error: any) {
          if (
            error.message === "VERSION_CONFLICT" &&
            retries < maxRetries - 1
          ) {
            retries++;
            // Retry with exponential backoff
            await new Promise((resolve) =>
              setTimeout(resolve, Math.pow(2, retries) * 100)
            );
          } else {
            throw error;
          }
        }
      }

      if (!success) {
        return NextResponse.json(
          { error: "Failed to update balance after retries" },
          { status: 500 }
        );
      }

      // Mark event as processed
      await markEventProcessed(eventMarkerKey);

      return NextResponse.json({ success: true }, { status: 200 });
    }

    // Acknowledge other events
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

async function checkEventProcessed(eventMarkerKey: string): Promise<boolean> {
  try {
    await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: eventMarkerKey,
      })
    );
    return true;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return false;
    }
    throw error;
  }
}

async function markEventProcessed(eventMarkerKey: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: eventMarkerKey,
      ContentType: "application/json",
      Body: JSON.stringify({ processed_at: new Date().toISOString() }),
    })
  );
}

async function getCreditBalance(
  repoSlug: string
): Promise<CreditBalance | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `credits/${repoSlug}/balance.json`,
      })
    );

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as CreditBalance;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return null;
    }
    throw error;
  }
}

async function putCreditBalance(
  balance: CreditBalance,
  expectedVersion: number
): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `credits/${balance.repo_slug}/balance.json`,
        ContentType: "application/json",
        Body: JSON.stringify(balance, null, 2),
        Metadata: {
          version: balance.version.toString(),
        },
      })
    );
  } catch (error) {
    throw error;
  }
}

async function appendTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const date = new Date(transaction.timestamp);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const ledgerPath = `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;

  let existingContent = "";
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: ledgerPath,
      })
    );

    if (result.Body) {
      existingContent = await result.Body.transformToString();
    }
  } catch (error: any) {
    if (error.name !== "NoSuchKey") {
      throw error;
    }
  }

  const newContent =
    existingContent + (existingContent ? "\n" : "") + JSON.stringify(transaction);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: ledgerPath,
      ContentType: "application/x-ndjson",
      Body: newContent,
    })
  );
}

async function updateCreditBalance(
  repoSlug: string,
  creditAmount: number,
  stripeSessionId: string
): Promise<void> {
  const now = new Date().toISOString();

  let balance = await getCreditBalance(repoSlug);

  if (!balance) {
    balance = {
      repo_slug: repoSlug,
      current_balance: 0,
      total_purchased: 0,
      total_spent: 0,
      last_updated: now,
      version: 0,
    };
  }

  const expectedVersion = balance.version;
  balance.current_balance += creditAmount;
  balance.total_purchased += creditAmount;
  balance.version += 1;
  balance.last_updated = now;

  // Try to write with optimistic locking
  try {
    await putCreditBalance(balance, expectedVersion);
  } catch (error) {
    // Check if another process updated the balance
    const updatedBalance = await getCreditBalance(repoSlug);
    if (updatedBalance && updatedBalance.version !== expectedVersion) {
      throw new Error("VERSION_CONFLICT");
    }
    throw error;
  }

  // Append transaction to ledger
  const transaction: CreditTransaction = {
    timestamp: now,
    type: "credit",
    amount: creditAmount,
    reason: `Stripe checkout session_id=${stripeSessionId}`,
    task_id: null,
    stripe_session_id: stripeSessionId,
  };

  await appendTransaction(repoSlug, transaction);
}
