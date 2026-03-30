/**
 * Credit Admin Handler
 *
 * REST API endpoint for managing credits across repositories.
 * Supports commands: balance, topup, transfer, history
 *
 * Triggered via HTTP POST requests with JSON body containing command and parameters.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  CreditBalance,
  CreditTransaction,
  parseRepoSlug,
  createRepoSlug,
  createCreditBalancePath,
  createCreditLedgerPath,
} from "./types";

const s3 = new S3Client({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || ""; // Optional: set in Lambda environment

interface AdminRequest {
  command: "balance" | "topup" | "transfer" | "history";
  repo?: string;
  all?: boolean;
  amount?: number;
  from_repo?: string;
  to_repo?: string;
  reason?: string;
  month?: string;
  api_key?: string;
}

interface AdminResponse {
  success: boolean;
  data?: any;
  error?: string;
}

async function getParameter(name: string): Promise<string> {
  // In a real scenario, this would use SSM, but for now we use env vars
  return process.env[name] || "";
}

async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const balancePath = createCreditBalancePath(repoSlug);
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: balancePath,
      })
    );

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as CreditBalance;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return {
        repo_slug: repoSlug,
        current_balance: 100, // Default to 100 free credits
        total_purchased: 0,
        total_spent: 0,
        last_updated: new Date().toISOString(),
        version: 1,
      };
    }
    throw error;
  }
}

async function setCreditBalance(balance: CreditBalance): Promise<void> {
  const balancePath = createCreditBalancePath(balance.repo_slug);
  await s3.send(
    new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: balancePath,
      Body: JSON.stringify(balance, null, 2),
      ContentType: "application/json",
    })
  );
}

async function appendTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const ledgerPath = createCreditLedgerPath(repoSlug, new Date(transaction.timestamp));

  try {
    // Try to get existing ledger
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: ledgerPath,
      })
    );
    const existingContent = await result.Body?.transformToString();
    let lines = existingContent ? existingContent.split("\n").filter((l) => l.trim()) : [];
    lines.push(JSON.stringify(transaction));

    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: ledgerPath,
        Body: lines.join("\n"),
        ContentType: "application/x-jsonlines",
      })
    );
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      // Create new ledger
      await s3.send(
        new PutObjectCommand({
          Bucket: ARTIFACTS_BUCKET,
          Key: ledgerPath,
          Body: JSON.stringify(transaction),
          ContentType: "application/x-jsonlines",
        })
      );
    } else {
      throw error;
    }
  }
}

async function getAllRepos(): Promise<string[]> {
  const repos = new Set<string>();
  let continuationToken: string | undefined;

  try {
    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: ARTIFACTS_BUCKET,
          Prefix: "credits/",
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      );

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          if (obj.Key?.endsWith("/balance.json")) {
            // Extract repo slug from path: credits/{owner}/{repo}/balance.json
            const parts = obj.Key.split("/");
            if (parts.length >= 3) {
              const repoSlug = `${parts[1]}/${parts[2]}`;
              repos.add(repoSlug);
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  } catch (error) {
    console.error("Error listing repos:", error);
  }

  return Array.from(repos).sort();
}

async function handleBalance(
  repoSlug?: string,
  all?: boolean
): Promise<object> {
  if (all || !repoSlug) {
    // Show all repos
    const repos = await getAllRepos();
    const balances: any[] = [];
    let totalBalance = 0;

    for (const repo of repos) {
      const balance = await getCreditBalance(repo);
      if (balance) {
        balances.push(balance);
        totalBalance += balance.current_balance;
      }
    }

    return {
      balances,
      total_org_balance: totalBalance,
      total_repos: repos.length,
    };
  } else {
    // Show single repo
    const balance = await getCreditBalance(repoSlug);
    return balance || { error: "Repository not found" };
  }
}

async function handleTopup(
  repoSlug: string,
  amount: number,
  reason?: string
): Promise<object> {
  if (!repoSlug || amount <= 0) {
    throw new Error("Invalid repo or amount");
  }

  const balance = await getCreditBalance(repoSlug);
  if (!balance) {
    throw new Error(`Repository ${repoSlug} not found`);
  }

  // Update balance with optimistic locking
  const oldVersion = balance.version;
  balance.current_balance += amount;
  balance.total_purchased += amount;
  balance.last_updated = new Date().toISOString();
  balance.version++;

  await setCreditBalance(balance);

  // Record transaction
  const transaction: CreditTransaction = {
    timestamp: new Date().toISOString(),
    type: "credit",
    amount,
    reason: reason || `Admin topup: +${amount} credits`,
    task_id: null,
  };

  await appendTransaction(repoSlug, transaction);

  return {
    repo: repoSlug,
    amount_added: amount,
    new_balance: balance.current_balance,
    reason: transaction.reason,
  };
}

async function handleTransfer(
  fromRepo: string,
  toRepo: string,
  amount: number
): Promise<object> {
  if (!fromRepo || !toRepo || amount <= 0) {
    throw new Error("Invalid repos or amount");
  }

  if (fromRepo === toRepo) {
    throw new Error("Cannot transfer to same repository");
  }

  // Get both balances
  const fromBalance = await getCreditBalance(fromRepo);
  const toBalance = await getCreditBalance(toRepo);

  if (!fromBalance || !toBalance) {
    throw new Error("One or both repositories not found");
  }

  if (fromBalance.current_balance < amount) {
    throw new Error(
      `Insufficient credits in ${fromRepo}: has ${fromBalance.current_balance}, needs ${amount}`
    );
  }

  // Update both balances
  fromBalance.current_balance -= amount;
  fromBalance.last_updated = new Date().toISOString();
  fromBalance.version++;

  toBalance.current_balance += amount;
  toBalance.last_updated = new Date().toISOString();
  toBalance.version++;

  await setCreditBalance(fromBalance);
  await setCreditBalance(toBalance);

  // Record transactions for both repos
  const now = new Date().toISOString();
  const reason = `Transfer to ${toRepo}`;

  const fromTransaction: CreditTransaction = {
    timestamp: now,
    type: "debit",
    amount,
    reason,
    task_id: null,
  };

  const toTransaction: CreditTransaction = {
    timestamp: now,
    type: "credit",
    amount,
    reason: `Transfer from ${fromRepo}`,
    task_id: null,
  };

  await appendTransaction(fromRepo, fromTransaction);
  await appendTransaction(toRepo, toTransaction);

  return {
    from_repo: fromRepo,
    to_repo: toRepo,
    amount_transferred: amount,
    from_balance_after: fromBalance.current_balance,
    to_balance_after: toBalance.current_balance,
  };
}

async function handleHistory(
  repoSlug: string,
  month?: string
): Promise<object> {
  if (!repoSlug) {
    throw new Error("Repository slug required for history");
  }

  const transactions: CreditTransaction[] = [];
  let targetDate: Date;

  if (month) {
    // Parse YYYY/MM format
    const [yyyy, mm] = month.split("/");
    targetDate = new Date(`${yyyy}-${mm}-01`);
  } else {
    targetDate = new Date();
  }

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, "0");
  const ledgerPath = `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;

  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: ledgerPath,
      })
    );

    const content = await result.Body?.transformToString();
    if (content) {
      const lines = content.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          transactions.push(JSON.parse(line));
        } catch (e) {
          // Skip malformed lines
        }
      }
    }
  } catch (error: any) {
    if (error.name !== "NoSuchKey") {
      throw error;
    }
    // NoSuchKey is fine, just return empty transactions
  }

  // Calculate running balance
  const balance = await getCreditBalance(repoSlug);
  let runningBalance = balance ? balance.current_balance : 0;

  // Reverse calculate running balance (assume balance is current)
  const withRunningBalance = transactions
    .reverse()
    .map((t) => {
      const prev = runningBalance;
      runningBalance -=
        t.type === "credit" || t.type === "refund" ? t.amount : -t.amount;
      return {
        ...t,
        running_balance_before: runningBalance,
        running_balance_after: prev,
      };
    })
    .reverse();

  return {
    repo: repoSlug,
    month: month || `${yyyy}/${mm}`,
    transactions: withRunningBalance,
    transaction_count: withRunningBalance.length,
  };
}

export async function handler(event: any): Promise<AdminResponse> {
  try {
    console.log("Credit admin request:", JSON.stringify(event));

    // Parse request body
    let request: AdminRequest;
    if (typeof event.body === "string") {
      request = JSON.parse(event.body);
    } else {
      request = event.body || event;
    }

    // Validate API key if configured
    if (ADMIN_API_KEY && request.api_key !== ADMIN_API_KEY) {
      return {
        success: false,
        error: "Unauthorized: Invalid or missing API key",
      };
    }

    // Handle commands
    switch (request.command) {
      case "balance":
        const balanceResult = await handleBalance(request.repo, request.all);
        return { success: true, data: balanceResult };

      case "topup":
        if (!request.repo || !request.amount) {
          throw new Error("topup requires repo and amount");
        }
        const topupResult = await handleTopup(
          request.repo,
          request.amount,
          request.reason
        );
        return { success: true, data: topupResult };

      case "transfer":
        if (!request.from_repo || !request.to_repo || !request.amount) {
          throw new Error("transfer requires from_repo, to_repo, and amount");
        }
        const transferResult = await handleTransfer(
          request.from_repo,
          request.to_repo,
          request.amount
        );
        return { success: true, data: transferResult };

      case "history":
        if (!request.repo) {
          throw new Error("history requires repo");
        }
        const historyResult = await handleHistory(request.repo, request.month);
        return { success: true, data: historyResult };

      default:
        throw new Error(`Unknown command: ${request.command}`);
    }
  } catch (error: any) {
    console.error("Error handling credit admin request:", error);
    return {
      success: false,
      error: error.message || "Internal server error",
    };
  }
}
