#!/usr/bin/env node
/**
 * Credit Admin CLI
 *
 * Command-line tool for managing repository credits.
 * Accesses S3 directly with AWS credentials.
 *
 * Usage:
 *   npm run credits balance [--repo owner/repo] [--all]
 *   npm run credits topup <owner/repo> <amount> [--reason "..."]
 *   npm run credits transfer <from-repo> <to-repo> <amount>
 *   npm run credits history <owner/repo> [--month YYYY/MM]
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import * as path from "path";

const s3 = new S3Client({});

// Read bucket from environment or config
const ARTIFACTS_BUCKET =
  process.env.ARTIFACTS_BUCKET ||
  "github-agent-artifacts-022118847419-us-east-1";

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

async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const balancePath = `credits/${repoSlug}/balance.json`;
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
        current_balance: 100,
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
  const balancePath = `credits/${balance.repo_slug}/balance.json`;
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
  const date = new Date(transaction.timestamp);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const ledgerPath = `credits/${repoSlug}/ledger/${yyyy}/${mm}/transactions.jsonl`;

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

function formatBalance(balance: CreditBalance): string {
  const {
    repo_slug,
    current_balance,
    total_purchased,
    total_spent,
  } = balance;
  return `${repo_slug.padEnd(25)} ${String(current_balance).padStart(5)} credits (${String(total_purchased).padStart(3)} purchased, ${String(total_spent).padStart(3)} spent)`;
}

async function handleBalance(repo?: string, allRepos?: boolean): Promise<void> {
  if (allRepos || !repo) {
    console.log("Repository Credits Summary");
    console.log("=".repeat(75));

    const repos = await getAllRepos();
    let totalBalance = 0;

    for (const r of repos) {
      const balance = await getCreditBalance(r);
      if (balance) {
        console.log(formatBalance(balance));
        totalBalance += balance.current_balance;
      }
    }

    console.log("-".repeat(75));
    console.log(
      `Total org: ${String(totalBalance).padStart(23)} credits across ${repos.length} repos`
    );
  } else {
    const balance = await getCreditBalance(repo);
    if (balance) {
      console.log("Repository Credits");
      console.log("=".repeat(75));
      console.log(formatBalance(balance));
    } else {
      console.log(`Repository ${repo} not found`);
      process.exit(1);
    }
  }
}

async function handleTopup(
  repo: string,
  amount: number,
  reason?: string
): Promise<void> {
  const balance = await getCreditBalance(repo);
  if (!balance && !reason) {
    console.log(`Repository ${repo} not found, creating with default balance`);
  }

  const targetBalance = balance || {
    repo_slug: repo,
    current_balance: 100,
    total_purchased: 0,
    total_spent: 0,
    last_updated: new Date().toISOString(),
    version: 1,
  };

  targetBalance.current_balance += amount;
  targetBalance.total_purchased += amount;
  targetBalance.last_updated = new Date().toISOString();
  targetBalance.version++;

  await setCreditBalance(targetBalance);

  const transaction: CreditTransaction = {
    timestamp: new Date().toISOString(),
    type: "credit",
    amount,
    reason: reason || `Admin topup: +${amount} credits`,
    task_id: null,
  };

  await appendTransaction(repo, transaction);

  console.log(`✓ Topped up ${repo} by ${amount} credits`);
  console.log(`  New balance: ${targetBalance.current_balance} credits`);
  console.log(`  Reason: ${transaction.reason}`);
}

async function handleTransfer(
  fromRepo: string,
  toRepo: string,
  amount: number
): Promise<void> {
  if (fromRepo === toRepo) {
    console.error("Error: Cannot transfer to same repository");
    process.exit(1);
  }

  const fromBalance = await getCreditBalance(fromRepo);
  const toBalance = await getCreditBalance(toRepo);

  if (!fromBalance || !toBalance) {
    console.error("Error: One or both repositories not found");
    process.exit(1);
  }

  if (fromBalance.current_balance < amount) {
    console.error(
      `Error: Insufficient credits in ${fromRepo}: has ${fromBalance.current_balance}, needs ${amount}`
    );
    process.exit(1);
  }

  fromBalance.current_balance -= amount;
  fromBalance.last_updated = new Date().toISOString();
  fromBalance.version++;

  toBalance.current_balance += amount;
  toBalance.last_updated = new Date().toISOString();
  toBalance.version++;

  await setCreditBalance(fromBalance);
  await setCreditBalance(toBalance);

  const now = new Date().toISOString();

  const fromTransaction: CreditTransaction = {
    timestamp: now,
    type: "debit",
    amount,
    reason: `Transfer to ${toRepo}`,
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

  console.log(`✓ Transferred ${amount} credits: ${fromRepo} → ${toRepo}`);
  console.log(`  ${fromRepo} balance after: ${fromBalance.current_balance} credits`);
  console.log(`  ${toRepo} balance after: ${toBalance.current_balance} credits`);
}

async function handleHistory(repo: string, month?: string): Promise<void> {
  const transactions: CreditTransaction[] = [];
  let targetDate: Date;

  if (month) {
    const [yyyy, mm] = month.split("/");
    targetDate = new Date(`${yyyy}-${mm}-01`);
  } else {
    targetDate = new Date();
  }

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, "0");
  const ledgerPath = `credits/${repo}/ledger/${yyyy}/${mm}/transactions.jsonl`;

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
  }

  console.log(`Transaction History: ${repo} (${yyyy}/${mm})`);
  console.log("=".repeat(100));

  if (transactions.length === 0) {
    console.log("No transactions in this month");
    return;
  }

  // Calculate running balance
  const balance = await getCreditBalance(repo);
  let runningBalance = balance ? balance.current_balance : 0;

  // Reverse to calculate running balance
  const withRunning = transactions
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

  for (const t of withRunning) {
    const typeStr = t.type === "credit" ? "+" : "-";
    const dateTime = new Date(t.timestamp).toLocaleString();
    console.log(
      `${dateTime.padEnd(20)} ${typeStr}${String(t.amount).padStart(4)} ${
        t.type.padEnd(6)
      } ${t.reason.substring(0, 40).padEnd(40)} [${t.running_balance_after}]`
    );
  }

  console.log("=".repeat(100));
  console.log(`Total entries: ${withRunning.length}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Credit Admin CLI

Usage:
  credits balance [--repo owner/repo] [--all]              Show credit balance
  credits topup <repo> <amount> [--reason "..."]           Add credits
  credits transfer <from> <to> <amount>                    Move credits between repos
  credits history <repo> [--month YYYY/MM]                 View transaction history
`);
    process.exit(1);
  }

  try {
    const command = args[0];

    switch (command) {
      case "balance": {
        let repo: string | undefined;
        let allRepos = false;

        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--repo" && args[i + 1]) {
            repo = args[++i];
          } else if (args[i] === "--all") {
            allRepos = true;
          }
        }

        await handleBalance(repo, allRepos || !repo);
        break;
      }

      case "topup": {
        if (args.length < 3) {
          console.error("Usage: credits topup <repo> <amount> [--reason \"...\"]");
          process.exit(1);
        }

        const repo = args[1];
        const amount = parseInt(args[2], 10);
        let reason: string | undefined;

        for (let i = 3; i < args.length; i++) {
          if (args[i] === "--reason" && args[i + 1]) {
            reason = args[++i];
          }
        }

        if (isNaN(amount) || amount <= 0) {
          console.error("Error: amount must be a positive number");
          process.exit(1);
        }

        await handleTopup(repo, amount, reason);
        break;
      }

      case "transfer": {
        if (args.length < 4) {
          console.error("Usage: credits transfer <from-repo> <to-repo> <amount>");
          process.exit(1);
        }

        const fromRepo = args[1];
        const toRepo = args[2];
        const amount = parseInt(args[3], 10);

        if (isNaN(amount) || amount <= 0) {
          console.error("Error: amount must be a positive number");
          process.exit(1);
        }

        await handleTransfer(fromRepo, toRepo, amount);
        break;
      }

      case "history": {
        if (args.length < 2) {
          console.error("Usage: credits history <repo> [--month YYYY/MM]");
          process.exit(1);
        }

        const repo = args[1];
        let month: string | undefined;

        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--month" && args[i + 1]) {
            month = args[++i];
          }
        }

        await handleHistory(repo, month);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error: any) {
    console.error("Error:", error.message || error);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
