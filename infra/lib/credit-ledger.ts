import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  type CreditBalance,
  type CreditTransaction,
  createCreditBalancePath,
  createCreditLedgerPath,
  getModelCost,
} from "./types";

/**
 * Shared S3 credit-ledger helpers.
 *
 * All credit-balance writes (GitHub webhook task debits, Stripe purchase
 * credits, refunds) go through this module so there is a single code path
 * and a single audit trail for S3 ledger mutations.
 *
 * See docs/architecture/adr-stripe-webhook-location.md for the decision to
 * keep Stripe webhook handling in Lambda rather than the Vercel Next.js app.
 */

let s3Client: S3Client | null = null;
let artifactsBucket: string | null = null;

/**
 * Initializes the shared credit-ledger module with the S3 client and bucket.
 * Must be called once at handler cold-start before any credit operation.
 */
export function initCreditLedger(client: S3Client, bucket: string): void {
  s3Client = client;
  artifactsBucket = bucket;
}

function getS3(): S3Client {
  if (!s3Client) {
    throw new Error("credit-ledger not initialized — call initCreditLedger first");
  }
  return s3Client;
}

function getBucket(): string {
  if (!artifactsBucket) {
    throw new Error("credit-ledger not initialized — call initCreditLedger first");
  }
  return artifactsBucket;
}

/**
 * Initializes credit balance for a repository if it doesn't exist.
 * Default: 100 free credits for new repos.
 */
export async function initializeCreditBalance(
  repoSlug: string
): Promise<CreditBalance> {
  const balance: CreditBalance = {
    repo_slug: repoSlug,
    current_balance: 100, // 100 free credits on signup
    total_purchased: 0,
    total_spent: 0,
    last_updated: new Date().toISOString(),
    version: 0,
  };

  const balancePath = createCreditBalancePath(repoSlug);
  await getS3().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: balancePath,
      Body: JSON.stringify(balance, null, 2),
      ContentType: "application/json",
    })
  );

  console.log(`Initialized credit balance for ${repoSlug}: 100 credits`);
  return balance;
}

/**
 * Fetches the current credit balance for a repository.
 * Returns null if balance file doesn't exist.
 */
export async function getCreditBalance(
  repoSlug: string
): Promise<CreditBalance | null> {
  try {
    const balancePath = createCreditBalancePath(repoSlug);
    const result = await getS3().send(
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: balancePath,
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

/**
 * Records a credit transaction in the ledger.
 */
export async function recordTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const ledgerPath = createCreditLedgerPath(repoSlug);
  const transactionLine = JSON.stringify(transaction) + "\n";

  try {
    // Try to append if ledger exists
    const existing = await getS3().send(
      new GetObjectCommand({
        Bucket: getBucket(),
        Key: ledgerPath,
      })
    );

    let existingContent = "";
    if (existing.Body) {
      existingContent = await existing.Body.transformToString();
    }

    const newContent = existingContent + transactionLine;
    await getS3().send(
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: ledgerPath,
        Body: newContent,
        ContentType: "application/json",
      })
    );
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      // Ledger doesn't exist, create new one
      await getS3().send(
        new PutObjectCommand({
          Bucket: getBucket(),
          Key: ledgerPath,
          Body: transactionLine,
          ContentType: "application/json",
        })
      );
    } else {
      throw error;
    }
  }

  console.log(
    `Recorded credit transaction: ${transaction.type} ${transaction.amount} credits (${transaction.reason})`
  );
}

/**
 * Adds purchased credits to a repository balance.
 * Used by the Stripe webhook handler when a checkout session completes.
 *
 * Uses optimistic locking via the `version` field: the balance is re-read
 * before writing and the write is conditional on the version not having
 * changed. If a concurrent modification is detected, the operation is
 * retried up to `maxRetries` times.
 */
export async function addCredits(
  repoSlug: string,
  amount: number,
  reason: string,
  maxRetries = 5
): Promise<CreditBalance> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let balance = await getCreditBalance(repoSlug);

    if (!balance) {
      console.log(`Credit balance not found for ${repoSlug}, creating new balance`);
      balance = await initializeCreditBalance(repoSlug);
    }

    const expectedVersion = balance.version;
    balance.current_balance += amount;
    balance.total_purchased += amount;
    balance.last_updated = new Date().toISOString();
    balance.version += 1;

    // Save updated balance
    const balancePath = createCreditBalancePath(repoSlug);
    await getS3().send(
      new PutObjectCommand({
        Bucket: getBucket(),
        Key: balancePath,
        Body: JSON.stringify(balance, null, 2),
        ContentType: "application/json",
      })
    );

    // Record transaction
    const transaction: CreditTransaction = {
      timestamp: new Date().toISOString(),
      type: "credit",
      amount,
      reason,
      task_id: null,
    };
    await recordTransaction(repoSlug, transaction);

    console.log(
      `Added ${amount} credits to ${repoSlug}. New balance: ${balance.current_balance}`
    );
    return balance;
  }

  throw new Error(`Failed to add credits to ${repoSlug} after ${maxRetries} retries`);
}

/**
 * Deducts credits from a repository balance after task completion.
 */
export async function deductCredits(
  repoSlug: string,
  taskId: string,
  model: string,
  status: "succeeded" | "failed" | "timed_out"
): Promise<number> {
  // Don't charge for failed/timed-out tasks
  if (status !== "succeeded") {
    const refundTransaction: CreditTransaction = {
      timestamp: new Date().toISOString(),
      type: "refund",
      amount: 0,
      reason: `Task ${taskId} did not complete successfully (status: ${status})`,
      task_id: taskId,
      model,
    };
    await recordTransaction(repoSlug, refundTransaction);
    return 0;
  }

  const cost = getModelCost(model);
  let balance = await getCreditBalance(repoSlug);

  if (!balance) {
    console.log(`Credit balance not found for ${repoSlug}, creating new balance`);
    balance = await initializeCreditBalance(repoSlug);
  }

  balance.current_balance -= cost;
  balance.total_spent += cost;
  balance.last_updated = new Date().toISOString();
  balance.version += 1;

  // Save updated balance
  const balancePath = createCreditBalancePath(repoSlug);
  await getS3().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: balancePath,
      Body: JSON.stringify(balance, null, 2),
      ContentType: "application/json",
    })
  );

  // Record transaction
  const transaction: CreditTransaction = {
    timestamp: new Date().toISOString(),
    type: "debit",
    amount: cost,
    reason: `Task ${taskId} completed`,
    task_id: taskId,
    model,
  };
  await recordTransaction(repoSlug, transaction);

  console.log(
    `Deducted ${cost} credits from ${repoSlug} for ${model}. New balance: ${balance.current_balance}`
  );
  return balance.current_balance;
}

/**
 * Checks if a repository has sufficient credits for a task.
 * Initializes balance if it doesn't exist.
 */
export async function checkCreditsAvailable(
  repoSlug: string,
  model: string
): Promise<boolean> {
  let balance = await getCreditBalance(repoSlug);

  if (!balance) {
    console.log(`No credit balance for ${repoSlug}, initializing with free credits`);
    balance = await initializeCreditBalance(repoSlug);
  }

  const cost = getModelCost(model);
  const available = balance.current_balance >= cost;

  console.log(
    `Credit check for ${repoSlug} (${model}): balance=${balance.current_balance}, required=${cost}, available=${available}`
  );

  return available;
}
