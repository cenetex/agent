#!/usr/bin/env node

/**
 * Credit Admin CLI
 *
 * Manages GitHub Agent credits:
 * - Check balance for repos or all repos
 * - Top up credits with audit trail
 * - Transfer credits between repos
 * - View transaction history
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { ArgumentParser } from "argparse";

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
  model?: string;
}

const s3 = new S3Client({});
const BUCKET = process.env.ARTIFACTS_BUCKET || "github-agent-artifacts-022118847419-us-east-1";

function validateRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo slug: ${slug}. Use format: owner/repo`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function createCreditBalancePath(repoSlug: string): string {
  return `credits/${repoSlug}/balance.json`;
}

function createCreditLedgerPath(repoSlug: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;
}


async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: createCreditBalancePath(repoSlug),
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

async function putCreditBalance(balance: CreditBalance): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: createCreditBalancePath(balance.repo_slug),
      ContentType: "application/json",
      Body: JSON.stringify(balance, null, 2),
    })
  );
}

async function appendTransaction(
  repoSlug: string,
  transaction: CreditTransaction
): Promise<void> {
  const ledgerPath = createCreditLedgerPath(repoSlug, new Date(transaction.timestamp));

  // Try to get the existing ledger file
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

  // Append new transaction
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

async function getTransactions(
  repoSlug: string,
  monthFilter?: string
): Promise<CreditTransaction[]> {
  const transactions: CreditTransaction[] = [];

  if (monthFilter) {
    // Specific month: YYYY/MM
    const [yyyy, mm] = monthFilter.split("/");
    const ledgerPath = `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;

    try {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: ledgerPath,
        })
      );

      if (result.Body) {
        const content = await result.Body.transformToString();
        for (const line of content.split("\n")) {
          if (line.trim()) {
            transactions.push(JSON.parse(line));
          }
        }
      }
    } catch (error: any) {
      if (error.name !== "NoSuchKey") {
        throw error;
      }
    }
  } else {
    // All months
    let continuationToken: string | undefined;
    const prefix = `credits/${repoSlug}/ledger/`;

    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      );

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          if (obj.Key?.endsWith("/transactions.jsonl")) {
            try {
              const result = await s3.send(
                new GetObjectCommand({
                  Bucket: BUCKET,
                  Key: obj.Key,
                })
              );

              if (result.Body) {
                const content = await result.Body.transformToString();
                for (const line of content.split("\n")) {
                  if (line.trim()) {
                    transactions.push(JSON.parse(line));
                  }
                }
              }
            } catch (error: any) {
              if (error.name !== "NoSuchKey") {
                console.warn(`Failed to read ${obj.Key}:`, error);
              }
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  }

  return transactions.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

async function getAllRepos(): Promise<string[]> {
  const repos = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const listResult = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "credits/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );

    if (listResult.Contents) {
      for (const obj of listResult.Contents) {
        if (obj.Key?.endsWith("/balance.json")) {
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

  return Array.from(repos).sort();
}

async function cmdBalance(
  repo?: string,
  allRepos: boolean = false
): Promise<void> {
  const reposToCheck: string[] = [];

  if (allRepos) {
    reposToCheck.push(...(await getAllRepos()));
  } else if (repo) {
    validateRepoSlug(repo);
    reposToCheck.push(repo);
  } else {
    throw new Error("Specify --repo or --all");
  }

  let totalBalance = 0;
  let totalPurchased = 0;
  let totalSpent = 0;

  const balances: Array<{ repo: string; balance: CreditBalance | null }> = [];

  for (const repoSlug of reposToCheck) {
    const balance = await getCreditBalance(repoSlug);
    balances.push({ repo: repoSlug, balance });

    if (balance) {
      totalBalance += balance.current_balance;
      totalPurchased += balance.total_purchased;
      totalSpent += balance.total_spent;
    }
  }

  // Print results
  console.log();
  for (const { repo, balance } of balances) {
    if (balance) {
      const bought = String(balance.total_purchased).padStart(3);
      const spent = String(balance.total_spent).padStart(3);
      const current = String(balance.current_balance).padStart(4);
      console.log(`${repo.padEnd(25)} ${current} credits (${bought} purchased, ${spent} spent)`);
    } else {
      console.log(`${repo.padEnd(25)} (no balance found)`);
    }
  }

  if (allRepos) {
    console.log();
    console.log(`Total org:              ${totalBalance} credits across ${reposToCheck.length} repos`);
  }
  console.log();
}

async function cmdTopup(
  repo: string,
  amount: number,
  reason?: string
): Promise<void> {
  validateRepoSlug(repo);

  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }

  let balance = await getCreditBalance(repo);
  if (!balance) {
    // Create new balance if it doesn't exist
    balance = {
      repo_slug: repo,
      current_balance: 0,
      total_purchased: 0,
      total_spent: 0,
      last_updated: new Date().toISOString(),
      version: 1,
    };
  }

  // Update balance
  balance.current_balance += amount;
  balance.total_purchased += amount;
  balance.version += 1;
  balance.last_updated = new Date().toISOString();

  // Write balance
  await putCreditBalance(balance);

  // Write transaction
  const transaction: CreditTransaction = {
    timestamp: new Date().toISOString(),
    type: "credit",
    amount,
    reason: reason || `Top up ${amount} credits`,
    task_id: null,
  };

  await appendTransaction(repo, transaction);

  console.log();
  console.log(`✅ Top up successful`);
  console.log(`Repository: ${repo}`);
  console.log(`Amount: +${amount} credits`);
  console.log(`New balance: ${balance.current_balance} credits`);
  console.log();
}

async function cmdTransfer(
  fromRepo: string,
  toRepo: string,
  amount: number
): Promise<void> {
  validateRepoSlug(fromRepo);
  validateRepoSlug(toRepo);

  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }

  if (fromRepo === toRepo) {
    throw new Error("Cannot transfer to the same repo");
  }

  // Get both balances
  let fromBalance = await getCreditBalance(fromRepo);
  if (!fromBalance) {
    throw new Error(`Source repo ${fromRepo} has no balance`);
  }

  let toBalance = await getCreditBalance(toRepo);
  if (!toBalance) {
    throw new Error(`Destination repo ${toRepo} has no balance`);
  }

  if (fromBalance.current_balance < amount) {
    throw new Error(
      `Insufficient balance: ${fromRepo} has ${fromBalance.current_balance}, trying to transfer ${amount}`
    );
  }

  // Update balances
  fromBalance.current_balance -= amount;
  fromBalance.version += 1;
  fromBalance.last_updated = new Date().toISOString();

  toBalance.current_balance += amount;
  toBalance.version += 1;
  toBalance.last_updated = new Date().toISOString();

  // Write both balances
  await Promise.all([putCreditBalance(fromBalance), putCreditBalance(toBalance)]);

  // Write transactions
  const now = new Date().toISOString();
  await Promise.all([
    appendTransaction(fromRepo, {
      timestamp: now,
      type: "debit",
      amount,
      reason: `Transfer to ${toRepo}`,
      task_id: null,
    }),
    appendTransaction(toRepo, {
      timestamp: now,
      type: "credit",
      amount,
      reason: `Transfer from ${fromRepo}`,
      task_id: null,
    }),
  ]);

  console.log();
  console.log(`✅ Transfer successful`);
  console.log(`From: ${fromRepo} (${fromBalance.current_balance} credits remaining)`);
  console.log(`To: ${toRepo} (${toBalance.current_balance} credits now)`);
  console.log(`Amount: ${amount} credits`);
  console.log();
}

async function cmdHistory(repo: string, month?: string): Promise<void> {
  validateRepoSlug(repo);

  const transactions = await getTransactions(repo, month);

  if (transactions.length === 0) {
    console.log(`\nNo transactions found for ${repo}\n`);
    return;
  }

  console.log();
  console.log(
    `Transaction history for ${repo}${month ? ` (${month})` : ""} (${transactions.length} transactions):`
  );
  console.log();

  for (const tx of transactions) {
    const sign = tx.type === "credit" || tx.type === "refund" ? "+" : "-";
    const typeLabel =
      tx.type === "credit" ? "CREDIT " : tx.type === "refund" ? "REFUND " : "DEBIT  ";
    const date = new Date(tx.timestamp).toISOString().split("T")[0];
    const time = new Date(tx.timestamp).toISOString().split("T")[1];
    const amountStr = String(tx.amount).padStart(4);

    console.log(
      `${date} ${time.split(".")[0]} ${typeLabel} ${sign}${amountStr} │ ${tx.reason}`
    );
  }

  console.log();
}

async function main() {
  const parser = new ArgumentParser({
    description: "GitHub Agent Credit Admin CLI",
  });

  const subparsers = parser.addSubparsers({
    title: "commands",
    dest: "command",
  });

  // balance command
  const balanceParser = subparsers.addParser("balance", {
    help: "Show credit balance",
  });
  balanceParser.addArgument("--repo", {
    help: "Repository (owner/repo)",
  });
  balanceParser.addArgument("--all", {
    action: "store_true",
    help: "Show all repositories",
  });

  // topup command
  const topupParser = subparsers.addParser("topup", {
    help: "Add credits to a repository",
  });
  topupParser.addArgument("repo", {
    help: "Repository (owner/repo)",
  });
  topupParser.addArgument("amount", {
    type: "int",
    help: "Amount of credits to add",
  });
  topupParser.addArgument("--reason", {
    help: "Reason for top up",
  });

  // transfer command
  const transferParser = subparsers.addParser("transfer", {
    help: "Transfer credits between repositories",
  });
  transferParser.addArgument("from", {
    help: "Source repository (owner/repo)",
  });
  transferParser.addArgument("to", {
    help: "Destination repository (owner/repo)",
  });
  transferParser.addArgument("amount", {
    type: "int",
    help: "Amount of credits to transfer",
  });

  // history command
  const historyParser = subparsers.addParser("history", {
    help: "Show transaction history",
  });
  historyParser.addArgument("repo", {
    help: "Repository (owner/repo)",
  });
  historyParser.addArgument("--month", {
    help: "Filter by month (YYYY/MM)",
  });

  const args = parser.parseArgs();

  try {
    switch (args.command) {
      case "balance":
        await cmdBalance(args.repo, args.all);
        break;

      case "topup":
        await cmdTopup(args.repo, args.amount, args.reason);
        break;

      case "transfer":
        await cmdTransfer(args.from, args.to, args.amount);
        break;

      case "history":
        await cmdHistory(args.repo, args.month);
        break;

      default:
        parser.printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
