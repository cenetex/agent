#!/usr/bin/env node

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type TaskStatus = "requested" | "running" | "succeeded" | "failed" | "timed_out" | "waiting";

interface TaskMetadata {
  task_id: string;
  repo_slug: string;
  issue_number: number;
  task_mode: string;
  status: TaskStatus | string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  failure_category?: string;
  pr_url?: string;
  issue_metadata?: {
    title?: string;
    labels?: string[];
  };
}

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
  type: "credit" | "debit" | "refund" | string;
  amount: number;
  reason: string;
  task_id: string | null;
  model?: string;
}

interface WindowStats {
  label: string;
  days: number | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  waiting: number;
  running: number;
  successRate: number | null;
  averageRuntimeMinutes: number | null;
  p50RuntimeMinutes: number | null;
  p95RuntimeMinutes: number | null;
  averageQueueMinutes: number | null;
}

interface RepoStats {
  repo: string;
  total: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  waiting: number;
  running: number;
  successRate: number | null;
  p95RuntimeMinutes: number | null;
}

interface DailyPoint {
  date: string;
  succeeded: number;
  failed: number;
  timedOut: number;
  running: number;
  waiting: number;
  total: number;
}

interface CreditSummary {
  balances: CreditBalance[];
  totalPurchased: number;
  totalSpent: number;
  totalBalance: number;
  lowBalanceRepos: CreditBalance[];
  spentInWindow: number;
  creditedInWindow: number;
}

interface ReportData {
  generatedAt: string;
  bucket: string;
  windowDays: number;
  source: "s3" | "sample";
  windows: WindowStats[];
  repos: RepoStats[];
  daily: DailyPoint[];
  failureCategories: Array<{ category: string; count: number }>;
  modes: Array<{ mode: string; count: number }>;
  credits: CreditSummary;
  recentTasks: TaskMetadata[];
}

const DEFAULT_BUCKET = "github-agent-artifacts-022118847419-us-east-1";
const COMPLETED_STATUSES = new Set(["succeeded", "failed", "timed_out"]);
const s3 = new S3Client({});

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printUsage(): void {
  console.log(`Usage: pages-report [options]

Options:
  --bucket <name>   S3 artifact bucket. Defaults to ARTIFACTS_BUCKET or ${DEFAULT_BUCKET}
  --out <dir>       Output directory for GitHub Pages artifacts. Defaults to ./pages
  --days <number>   Reporting window for trend and credit spend. Defaults to 30
  --sample          Render a deterministic sample report without AWS access
  --help            Show this help
`);
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTime(value?: string): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function minutesBetween(start?: string, end?: string): number | null {
  const startTime = parseTime(start);
  const endTime = parseTime(end);
  if (startTime === null || endTime === null || endTime < startTime) {
    return null;
  }
  return (endTime - startTime) / 60000;
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], rank: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function round(value: number | null, places = 1): number | null {
  if (value === null) {
    return null;
  }
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function successRate(succeeded: number, failed: number, timedOut: number): number | null {
  const completed = succeeded + failed + timedOut;
  if (completed === 0) {
    return null;
  }
  return Math.round((succeeded / completed) * 100);
}

function filterTasksByDays(tasks: TaskMetadata[], days: number | null, now: Date): TaskMetadata[] {
  if (days === null) {
    return tasks;
  }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return tasks.filter((task) => {
    const created = parseTime(task.created_at);
    return created !== null && created >= cutoff;
  });
}

function summarizeWindow(label: string, days: number | null, tasks: TaskMetadata[]): WindowStats {
  const succeeded = tasks.filter((task) => task.status === "succeeded").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const timedOut = tasks.filter((task) => task.status === "timed_out").length;
  const waiting = tasks.filter((task) => task.status === "waiting").length;
  const running = tasks.filter((task) => task.status === "running").length;
  const runtimeMinutes = tasks
    .map((task) => minutesBetween(task.started_at, task.completed_at))
    .filter((value): value is number => value !== null);
  const queueMinutes = tasks
    .map((task) => minutesBetween(task.created_at, task.started_at))
    .filter((value): value is number => value !== null);

  return {
    label,
    days,
    total: tasks.length,
    completed: tasks.filter((task) => COMPLETED_STATUSES.has(task.status)).length,
    succeeded,
    failed,
    timedOut,
    waiting,
    running,
    successRate: successRate(succeeded, failed, timedOut),
    averageRuntimeMinutes: round(average(runtimeMinutes)),
    p50RuntimeMinutes: round(percentile(runtimeMinutes, 50)),
    p95RuntimeMinutes: round(percentile(runtimeMinutes, 95)),
    averageQueueMinutes: round(average(queueMinutes)),
  };
}

function summarizeRepos(tasks: TaskMetadata[]): RepoStats[] {
  const byRepo = new Map<string, TaskMetadata[]>();
  for (const task of tasks) {
    const repoTasks = byRepo.get(task.repo_slug) ?? [];
    repoTasks.push(task);
    byRepo.set(task.repo_slug, repoTasks);
  }

  return Array.from(byRepo.entries())
    .map(([repo, repoTasks]) => {
      const succeeded = repoTasks.filter((task) => task.status === "succeeded").length;
      const failed = repoTasks.filter((task) => task.status === "failed").length;
      const timedOut = repoTasks.filter((task) => task.status === "timed_out").length;
      const runtimeMinutes = repoTasks
        .map((task) => minutesBetween(task.started_at, task.completed_at))
        .filter((value): value is number => value !== null);

      return {
        repo,
        total: repoTasks.length,
        succeeded,
        failed,
        timedOut,
        waiting: repoTasks.filter((task) => task.status === "waiting").length,
        running: repoTasks.filter((task) => task.status === "running").length,
        successRate: successRate(succeeded, failed, timedOut),
        p95RuntimeMinutes: round(percentile(runtimeMinutes, 95)),
      };
    })
    .sort((left, right) => right.total - left.total || left.repo.localeCompare(right.repo));
}

function summarizeDaily(tasks: TaskMetadata[], days: number, now: Date): DailyPoint[] {
  const points = new Map<string, DailyPoint>();

  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    points.set(date, { date, succeeded: 0, failed: 0, timedOut: 0, running: 0, waiting: 0, total: 0 });
  }

  for (const task of tasks) {
    const date = task.created_at.slice(0, 10);
    const point = points.get(date);
    if (!point) {
      continue;
    }
    point.total++;
    if (task.status === "succeeded") {
      point.succeeded++;
    } else if (task.status === "failed") {
      point.failed++;
    } else if (task.status === "timed_out") {
      point.timedOut++;
    } else if (task.status === "running") {
      point.running++;
    } else if (task.status === "waiting") {
      point.waiting++;
    }
  }

  return Array.from(points.values());
}

function summarizeCounts(tasks: TaskMetadata[], field: "task_mode" | "failure_category"): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const value = task[field] || "unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

async function listKeys(bucket: string, prefix: string, suffix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const object of result.Contents ?? []) {
      if (object.Key?.endsWith(suffix)) {
        keys.push(object.Key);
      }
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function getText(bucket: string, key: string): Promise<string | null> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return result.Body ? await result.Body.transformToString() : null;
  } catch (error) {
    console.warn(`Skipping unreadable S3 object ${key}: ${errorMessage(error)}`);
    return null;
  }
}

async function getJson<T>(bucket: string, key: string): Promise<T | null> {
  const text = await getText(bucket, key);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    console.warn(`Skipping invalid JSON object ${key}: ${errorMessage(error)}`);
    return null;
  }
}

async function collectTasks(bucket: string): Promise<TaskMetadata[]> {
  const keys = await listKeys(bucket, "tasks/", "/metadata.json");
  const tasks: TaskMetadata[] = [];

  for (const key of keys) {
    const task = await getJson<TaskMetadata>(bucket, key);
    if (task) {
      tasks.push(task);
    }
  }

  return tasks.sort((left, right) => {
    const rightTime = parseTime(right.created_at) ?? 0;
    const leftTime = parseTime(left.created_at) ?? 0;
    return rightTime - leftTime;
  });
}

async function collectBalances(bucket: string): Promise<CreditBalance[]> {
  const keys = await listKeys(bucket, "credits/", "/balance.json");
  const balances: CreditBalance[] = [];

  for (const key of keys) {
    const balance = await getJson<CreditBalance>(bucket, key);
    if (balance) {
      balances.push(balance);
    }
  }

  return balances.sort((left, right) => left.current_balance - right.current_balance || left.repo_slug.localeCompare(right.repo_slug));
}

async function collectTransactions(bucket: string): Promise<Array<CreditTransaction & { repo_slug: string }>> {
  const keys = await listKeys(bucket, "credits/", "/transactions.jsonl");
  const transactions: Array<CreditTransaction & { repo_slug: string }> = [];

  for (const key of keys) {
    const text = await getText(bucket, key);
    if (!text) {
      continue;
    }
    const parts = key.split("/");
    const repo_slug = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : "unknown/unknown";
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        transactions.push({ ...(JSON.parse(line) as CreditTransaction), repo_slug });
      } catch (error) {
        console.warn(`Skipping invalid transaction in ${key}: ${errorMessage(error)}`);
      }
    }
  }

  return transactions;
}

function summarizeCredits(
  balances: CreditBalance[],
  transactions: Array<CreditTransaction & { repo_slug: string }>,
  days: number,
  now: Date
): CreditSummary {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const windowTransactions = transactions.filter((transaction) => {
    const time = parseTime(transaction.timestamp);
    return time !== null && time >= cutoff;
  });

  return {
    balances,
    totalPurchased: round(balances.reduce((sum, balance) => sum + balance.total_purchased, 0), 2) ?? 0,
    totalSpent: round(balances.reduce((sum, balance) => sum + balance.total_spent, 0), 2) ?? 0,
    totalBalance: round(balances.reduce((sum, balance) => sum + balance.current_balance, 0), 2) ?? 0,
    lowBalanceRepos: balances.filter((balance) => balance.current_balance < 10),
    spentInWindow: round(windowTransactions
      .filter((transaction) => transaction.type === "debit")
      .reduce((sum, transaction) => sum + transaction.amount, 0), 2) ?? 0,
    creditedInWindow: round(windowTransactions
      .filter((transaction) => transaction.type === "credit" || transaction.type === "refund")
      .reduce((sum, transaction) => sum + transaction.amount, 0), 2) ?? 0,
  };
}

function buildReport(
  tasks: TaskMetadata[],
  balances: CreditBalance[],
  transactions: Array<CreditTransaction & { repo_slug: string }>,
  bucket: string,
  days: number,
  source: "s3" | "sample"
): ReportData {
  const now = new Date();
  const windowTasks = filterTasksByDays(tasks, days, now);

  return {
    generatedAt: now.toISOString(),
    bucket,
    windowDays: days,
    source,
    windows: [
      summarizeWindow("24 hours", 1, filterTasksByDays(tasks, 1, now)),
      summarizeWindow("7 days", 7, filterTasksByDays(tasks, 7, now)),
      summarizeWindow(`${days} days`, days, windowTasks),
      summarizeWindow("All time", null, tasks),
    ],
    repos: summarizeRepos(windowTasks),
    daily: summarizeDaily(windowTasks, Math.min(days, 60), now),
    failureCategories: summarizeCounts(windowTasks.filter((task) => task.status === "failed"), "failure_category"),
    modes: summarizeCounts(windowTasks, "task_mode").map((entry) => ({ mode: entry.category, count: entry.count })),
    credits: summarizeCredits(balances, transactions, days, now),
    recentTasks: tasks.slice(0, 50),
  };
}

function sampleTasks(now: Date): TaskMetadata[] {
  const repos = ["atimics/AutoForwarder", "cenetex/agent", "cenetex/ratibot"];
  const statuses: TaskStatus[] = ["succeeded", "succeeded", "succeeded", "failed", "waiting", "timed_out"];
  const tasks: TaskMetadata[] = [];

  for (let index = 0; index < 36; index++) {
    const created = new Date(now.getTime() - index * 19 * 60 * 60 * 1000);
    const started = new Date(created.getTime() + (3 + (index % 7)) * 60 * 1000);
    const completed = new Date(started.getTime() + (18 + (index % 11) * 4) * 60 * 1000);
    const status = statuses[index % statuses.length] ?? "succeeded";
    tasks.push({
      task_id: `sample_task_${String(index + 1).padStart(2, "0")}`,
      repo_slug: repos[index % repos.length] ?? repos[0]!,
      issue_number: 100 + index,
      task_mode: index % 5 === 0 ? "pull_request" : "issue",
      status,
      created_at: created.toISOString(),
      started_at: started.toISOString(),
      completed_at: COMPLETED_STATUSES.has(status) ? completed.toISOString() : undefined,
      failure_category: status === "failed" ? (index % 2 === 0 ? "compilation_error" : "external_service") : undefined,
      pr_url: status === "succeeded" ? `https://github.com/${repos[index % repos.length]}/pull/${200 + index}` : undefined,
      issue_metadata: {
        title: `Sample automation task ${index + 1}`,
        labels: ["agent"],
      },
    });
  }

  return tasks;
}

function sampleBalances(now: Date): CreditBalance[] {
  return [
    { repo_slug: "atimics/AutoForwarder", current_balance: 92, total_purchased: 220, total_spent: 128, last_updated: now.toISOString(), version: 4 },
    { repo_slug: "cenetex/agent", current_balance: 37, total_purchased: 100, total_spent: 63, last_updated: now.toISOString(), version: 3 },
    { repo_slug: "cenetex/ratibot", current_balance: 7, total_purchased: 25, total_spent: 18, last_updated: now.toISOString(), version: 2 },
  ];
}

function sampleTransactions(now: Date): Array<CreditTransaction & { repo_slug: string }> {
  return [
    { repo_slug: "atimics/AutoForwarder", timestamp: now.toISOString(), type: "debit", amount: 12, reason: "sample task", task_id: "sample_task_01", model: "z-ai/glm-5.2" },
    { repo_slug: "cenetex/agent", timestamp: now.toISOString(), type: "credit", amount: 50, reason: "sample top up", task_id: null },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value: number | null, suffix = ""): string {
  if (value === null) {
    return "n/a";
  }
  return `${value.toLocaleString()}${suffix}`;
}

function statusClass(status: string): string {
  if (status === "succeeded") return "good";
  if (status === "failed" || status === "timed_out") return "bad";
  if (status === "running" || status === "waiting") return "warn";
  return "neutral";
}

function renderBars(points: DailyPoint[]): string {
  const maxTotal = Math.max(1, ...points.map((point) => point.total));
  return points.map((point) => {
    const height = Math.max(4, Math.round((point.total / maxTotal) * 120));
    const good = point.total > 0 ? Math.round((point.succeeded / point.total) * 100) : 0;
    const bad = point.total > 0 ? Math.round(((point.failed + point.timedOut) / point.total) * 100) : 0;
    return `<div class="bar" title="${escapeHtml(point.date)}: ${point.total} tasks">
      <div class="bar-fill" style="height:${height}px">
        <span class="bar-good" style="height:${good}%"></span>
        <span class="bar-bad" style="height:${bad}%"></span>
      </div>
      <span>${escapeHtml(point.date.slice(5))}</span>
    </div>`;
  }).join("");
}

function renderHtml(report: ReportData): string {
  const current = report.windows[2] ?? report.windows[0]!;
  const maxRepoTotal = Math.max(1, ...report.repos.map((repo) => repo.total));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Benchmarks and Statistics</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --text: #19202a;
      --muted: #667085;
      --line: #d9dee8;
      --good: #168a4a;
      --bad: #c63d3d;
      --warn: #b7791f;
      --accent: #255f9f;
      --accent-2: #6b5b95;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101418;
        --panel: #171c22;
        --text: #edf1f7;
        --muted: #a2adbc;
        --line: #2c3440;
        --accent: #7ab7ff;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    .wrap {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
    }
    header .wrap {
      padding: 28px 0 22px;
      display: grid;
      gap: 8px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 {
      font-size: clamp(30px, 5vw, 54px);
      line-height: 1;
      letter-spacing: 0;
    }
    h2 { font-size: 22px; margin-bottom: 12px; }
    h3 { font-size: 16px; margin-bottom: 8px; }
    .meta, .muted { color: var(--muted); }
    main { padding: 24px 0 44px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 22px;
    }
    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 16px; }
    .metric strong {
      display: block;
      font-size: 30px;
      line-height: 1.1;
      margin-top: 8px;
    }
    section {
      padding: 18px;
      margin-top: 14px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 650;
      white-space: nowrap;
    }
    tr:last-child td { border-bottom: 0; }
    .pill {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      white-space: nowrap;
    }
    .good { color: var(--good); }
    .bad { color: var(--bad); }
    .warn { color: var(--warn); }
    .neutral { color: var(--muted); }
    .bars {
      display: flex;
      gap: 8px;
      align-items: end;
      min-height: 166px;
      padding-top: 12px;
    }
    .bar {
      flex: 1;
      min-width: 18px;
      display: grid;
      gap: 6px;
      text-align: center;
      color: var(--muted);
      font-size: 11px;
    }
    .bar-fill {
      position: relative;
      height: 4px;
      border-radius: 4px 4px 0 0;
      background: #cbd5e1;
      overflow: hidden;
    }
    .bar-good, .bar-bad {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      display: block;
    }
    .bar-good { background: var(--good); }
    .bar-bad { background: var(--bad); opacity: 0.85; }
    .repo-bar {
      width: 100%;
      height: 8px;
      margin-top: 5px;
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border-radius: 999px;
      overflow: hidden;
    }
    .repo-bar span {
      display: block;
      height: 100%;
      background: var(--accent);
    }
    a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .links a {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 10px;
      text-decoration: none;
      background: var(--panel);
    }
    @media (max-width: 860px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
      .wrap { width: min(100% - 20px, 1180px); }
      th, td { padding: 9px 6px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <p class="meta">GitHub Agent</p>
      <h1>Benchmarks and Statistics</h1>
      <p class="meta">Generated ${escapeHtml(report.generatedAt)} from ${escapeHtml(report.source)} data in ${escapeHtml(report.bucket)}.</p>
      <div class="links">
        <a href="./data.json">Download JSON</a>
        <a href="./tasks.csv">Download task CSV</a>
      </div>
    </div>
  </header>
  <main class="wrap">
    <div class="grid">
      <div class="metric"><span class="muted">${escapeHtml(current.label)} tasks</span><strong>${formatNumber(current.total)}</strong></div>
      <div class="metric"><span class="muted">${escapeHtml(current.label)} success</span><strong>${formatNumber(current.successRate, "%")}</strong></div>
      <div class="metric"><span class="muted">P95 runtime</span><strong>${formatNumber(current.p95RuntimeMinutes, "m")}</strong></div>
      <div class="metric"><span class="muted">Credit balance</span><strong>${formatNumber(report.credits.totalBalance)}</strong></div>
    </div>

    <section>
      <h2>Operating Benchmarks</h2>
      <table>
        <thead><tr><th>Window</th><th>Total</th><th>Completed</th><th>Succeeded</th><th>Failed</th><th>Timed out</th><th>Running</th><th>Waiting</th><th>Success</th><th>P50 runtime</th><th>P95 runtime</th><th>Avg queue</th></tr></thead>
        <tbody>
          ${report.windows.map((window) => `<tr>
            <td>${escapeHtml(window.label)}</td>
            <td>${window.total}</td>
            <td>${window.completed}</td>
            <td class="good">${window.succeeded}</td>
            <td class="bad">${window.failed}</td>
            <td class="bad">${window.timedOut}</td>
            <td class="warn">${window.running}</td>
            <td class="warn">${window.waiting}</td>
            <td>${formatNumber(window.successRate, "%")}</td>
            <td>${formatNumber(window.p50RuntimeMinutes, "m")}</td>
            <td>${formatNumber(window.p95RuntimeMinutes, "m")}</td>
            <td>${formatNumber(window.averageQueueMinutes, "m")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Daily Throughput</h2>
      <p class="muted">Last ${report.daily.length} days. Green is succeeded; red is failed or timed out.</p>
      <div class="bars">${renderBars(report.daily)}</div>
    </section>

    <section>
      <h2>Repository Statistics</h2>
      <table>
        <thead><tr><th>Repository</th><th>Total</th><th>Success</th><th>Failed</th><th>Timed out</th><th>Open states</th><th>P95 runtime</th></tr></thead>
        <tbody>
          ${report.repos.map((repo) => `<tr>
            <td>${escapeHtml(repo.repo)}<div class="repo-bar"><span style="width:${Math.round((repo.total / maxRepoTotal) * 100)}%"></span></div></td>
            <td>${repo.total}</td>
            <td>${formatNumber(repo.successRate, "%")}</td>
            <td class="bad">${repo.failed}</td>
            <td class="bad">${repo.timedOut}</td>
            <td>${repo.running + repo.waiting}</td>
            <td>${formatNumber(repo.p95RuntimeMinutes, "m")}</td>
          </tr>`).join("") || `<tr><td colspan="7" class="muted">No repository data in this window.</td></tr>`}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Credits</h2>
      <div class="grid">
        <div class="metric"><span class="muted">Spent in window</span><strong>${formatNumber(report.credits.spentInWindow)}</strong></div>
        <div class="metric"><span class="muted">Credited in window</span><strong>${formatNumber(report.credits.creditedInWindow)}</strong></div>
        <div class="metric"><span class="muted">All-time spent</span><strong>${formatNumber(report.credits.totalSpent)}</strong></div>
        <div class="metric"><span class="muted">Low balances</span><strong>${formatNumber(report.credits.lowBalanceRepos.length)}</strong></div>
      </div>
      <table>
        <thead><tr><th>Repository</th><th>Balance</th><th>Total purchased</th><th>Total spent</th><th>Updated</th></tr></thead>
        <tbody>
          ${report.credits.balances.map((balance) => `<tr>
            <td>${escapeHtml(balance.repo_slug)}</td>
            <td class="${balance.current_balance < 10 ? "bad" : "good"}">${formatNumber(balance.current_balance)}</td>
            <td>${formatNumber(balance.total_purchased)}</td>
            <td>${formatNumber(balance.total_spent)}</td>
            <td>${escapeHtml(balance.last_updated)}</td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No credit balances found.</td></tr>`}
        </tbody>
      </table>
    </section>

    <section>
      <h2>Failure Categories and Modes</h2>
      <div class="grid">
        <div>
          <h3>Failure categories</h3>
          <table><tbody>${report.failureCategories.map((item) => `<tr><td>${escapeHtml(item.category)}</td><td>${item.count}</td></tr>`).join("") || `<tr><td class="muted">No failures in window.</td></tr>`}</tbody></table>
        </div>
        <div>
          <h3>Task modes</h3>
          <table><tbody>${report.modes.map((item) => `<tr><td>${escapeHtml(item.mode)}</td><td>${item.count}</td></tr>`).join("") || `<tr><td class="muted">No tasks in window.</td></tr>`}</tbody></table>
        </div>
      </div>
    </section>

    <section>
      <h2>Recent Tasks</h2>
      <table>
        <thead><tr><th>Task</th><th>Repository</th><th>Issue</th><th>Status</th><th>Runtime</th><th>Title</th><th>PR</th></tr></thead>
        <tbody>
          ${report.recentTasks.map((task) => `<tr>
            <td><code>${escapeHtml(task.task_id)}</code></td>
            <td>${escapeHtml(task.repo_slug)}</td>
            <td>#${escapeHtml(task.issue_number)}</td>
            <td><span class="pill ${statusClass(task.status)}">${escapeHtml(task.status)}</span></td>
            <td>${formatNumber(round(minutesBetween(task.started_at, task.completed_at)), "m")}</td>
            <td>${escapeHtml(task.issue_metadata?.title ?? "")}</td>
            <td>${task.pr_url ? `<a href="${escapeHtml(task.pr_url)}">PR</a>` : ""}</td>
          </tr>`).join("") || `<tr><td colspan="7" class="muted">No task metadata found.</td></tr>`}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function renderCsv(tasks: TaskMetadata[]): string {
  const rows = [
    ["task_id", "repo_slug", "issue_number", "task_mode", "status", "created_at", "started_at", "completed_at", "runtime_minutes", "pr_url", "title"],
    ...tasks.map((task) => [
      task.task_id,
      task.repo_slug,
      task.issue_number,
      task.task_mode,
      task.status,
      task.created_at,
      task.started_at ?? "",
      task.completed_at ?? "",
      round(minutesBetween(task.started_at, task.completed_at)) ?? "",
      task.pr_url ?? "",
      task.issue_metadata?.title ?? "",
    ]),
  ];

  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

async function writeReport(report: ReportData, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "index.html"), renderHtml(report), "utf8");
  await writeFile(path.join(outDir, "data.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "tasks.csv"), renderCsv(report.recentTasks), "utf8");
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printUsage();
    return;
  }

  const bucket = argValue("--bucket", process.env.ARTIFACTS_BUCKET || DEFAULT_BUCKET);
  const outDir = argValue("--out", "pages");
  const days = parsePositiveInt(argValue("--days", "30"), 30);
  const source = hasFlag("--sample") ? "sample" : "s3";
  const now = new Date();

  const tasks = source === "sample" ? sampleTasks(now) : await collectTasks(bucket);
  const balances = source === "sample" ? sampleBalances(now) : await collectBalances(bucket);
  const transactions = source === "sample" ? sampleTransactions(now) : await collectTransactions(bucket);
  const report = buildReport(tasks, balances, transactions, bucket, days, source);

  await writeReport(report, outDir);
  console.log(`Wrote GitHub Pages report to ${outDir}`);
  console.log(`Tasks: ${tasks.length}; repositories: ${report.repos.length}; credit balances: ${balances.length}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
