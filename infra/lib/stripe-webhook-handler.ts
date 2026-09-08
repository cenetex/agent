import { createHmac, timingSafeEqual } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  initCreditLedger,
  addCredits,
} from "./credit-ledger";

/**
 * Stripe Webhook Handler (Lambda)
 *
 * Receives Stripe webhook events for credit purchases and writes them to the
 * S3 credit ledger via the shared credit-ledger module. This is the single
 * source of truth for Stripe-originated credit writes.
 *
 * See docs/architecture/adr-stripe-webhook-location.md for the decision
 * rationale (Lambda over Vercel).
 */

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const STRIPE_WEBHOOK_SECRET_PARAM = process.env.STRIPE_WEBHOOK_SECRET_PARAM!;

/**
 * Verifies the Stripe-Signature header using the Stripe webhook signing secret.
 *
 * Stripe sends three header components:
 *   t=<timestamp>,v1=<signature>,v1=<signature2...>
 *
 * We reconstruct the signed payload as `${timestamp}.${rawBody}` and compare
 * the first v1 signature against our HMAC-SHA256 digest.
 */
function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  const parts = signatureHeader.split(",");
  let timestamp = "";
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  for (const sig of signatures) {
    const sigBuffer = Buffer.from(sig, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)) {
      return true;
    }
  }

  return false;
}

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

/**
 * Extracts the repo slug and credit amount from a Stripe checkout.session.completed event.
 *
 * The Stripe Checkout Session metadata is expected to contain:
 *   - repo_slug: the repository in owner/name format
 *   - credits: the number of credits purchased (string)
 *
 * Returns null if required metadata is missing.
 */
function extractPurchaseInfo(payload: any): {
  repoSlug: string;
  credits: number;
  sessionId: string;
} | null {
  const metadata = payload?.data?.object?.metadata;
  if (!metadata) return null;

  const repoSlug = metadata.repo_slug;
  const credits = parseInt(metadata.credits, 10);
  const sessionId = payload?.data?.object?.id;

  if (!repoSlug || !Number.isFinite(credits) || credits <= 0 || !sessionId) {
    return null;
  }

  return { repoSlug, credits, sessionId };
}

export async function handler(event: {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}) {
  console.log("Received Stripe webhook event");

  // Initialize shared credit-ledger module
  initCreditLedger(s3, ARTIFACTS_BUCKET);

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  // --- Verify Stripe signature ---
  const signatureHeader =
    event.headers["stripe-signature"] ??
    event.headers["Stripe-Signature"] ??
    "";

  if (!signatureHeader) {
    console.error("Missing Stripe-Signature header");
    return { statusCode: 401, body: "Missing signature" };
  }

  let webhookSecret: string;
  try {
    webhookSecret = await getParameter(STRIPE_WEBHOOK_SECRET_PARAM);
  } catch (error) {
    console.error("Failed to retrieve Stripe webhook secret from SSM", error);
    return { statusCode: 500, body: "Configuration error" };
  }

  if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
    console.error("Invalid Stripe signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  // --- Parse and handle event ---
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    console.error("Failed to parse Stripe webhook payload", error);
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const eventType = payload?.type ?? "";
  console.log(`Stripe event type: ${eventType}`);

  // Only handle checkout.session.completed for credit purchases
  if (eventType !== "checkout.session.completed") {
    console.log(`Ignoring Stripe event: ${eventType}`);
    return { statusCode: 200, body: `Ignored: ${eventType}` };
  }

  const purchase = extractPurchaseInfo(payload);
  if (!purchase) {
    console.error(
      "Missing or invalid metadata in checkout.session.completed event"
    );
    return {
      statusCode: 400,
      body: "Missing required metadata (repo_slug, credits)",
    };
  }

  try {
    await addCredits(
      purchase.repoSlug,
      purchase.credits,
      `Stripe checkout purchase (session ${purchase.sessionId})`
    );
    console.log(
      `Successfully processed Stripe purchase: ${purchase.credits} credits for ${purchase.repoSlug}`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        repo_slug: purchase.repoSlug,
        credits_added: purchase.credits,
      }),
    };
  } catch (error) {
    console.error(
      `Failed to add credits for ${purchase.repoSlug}:`,
      error
    );
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process credit purchase" }),
    };
  }
}
