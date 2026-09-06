/**
 * Unblocker Failure-Graph Collector
 *
 * Runs every 15 minutes (via EventBridge cron) to:
 * 1. Query GitHub for all open issues/PRs with `agent:failed` or `agent:waiting` labels
 * 2. Fetch task metadata from S3 for error details
 * 3. Collect GitHub check-run status for PRs
 * 4. Write a timestamped JSON snapshot to S3
 * 5. Update `latest.json` pointer for readers
 *
 * SCALE TRIGGER: When fleet reaches ~500 concurrent active tasks (~2000 API calls per run),
 * evaluate switching from polling to a webhook-driven incremental model.
 * See infra/lib/unblocker/ADR.md for rate-limit analysis and design decisions.
 */

import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { TaskMetadata } from "../types";
import { getInstallationToken, type GitHubAppConfig } from "../types";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const cloudwatch = new CloudWatchClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

async function githubRequest(
  path: string,
  token: string,
  init: RequestInit,
  expectedStatuses: number[]
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-agent-unblocker-collector",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!expectedStatuses.includes(response.status)) {
    const responseBody = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${responseBody}`
    );
  }

  return response;
}

async function getTaskMetadata(metadataKey: string): Promise<TaskMetadata | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: metadataKey,
      })
    );

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as TaskMetadata;
  } catch (error) {
    console.error(`Failed to get metadata ${metadataKey}:`, error);
    return null;
  }
}

interface TaskRef {
  task_id: string;
  created_at: string;
}

async function findLastTaskForIssue(
  repoSlug: string,
  issueNumber: number,
  status: "failed" | "waiting"
): Promise<TaskRef | null> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    let continuationToken: string | undefined;
    let latestTask: TaskRef | null = null;

    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: ARTIFACTS_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      );

      if (!listResult.Contents) break;

      const metadataKeys = listResult.Contents.filter((obj: any) =>
        obj.Key?.endsWith("/metadata.json")
      ).map((obj: any) => obj.Key!);

      for (const metadataKey of metadataKeys) {
        const metadata = await getTaskMetadata(metadataKey);
        if (!metadata) continue;

        if (
          metadata.issue_number === issueNumber &&
          (status === "failed"
            ? metadata.status === "failed"
            : metadata.status === "waiting")
        ) {
          if (
            !latestTask ||
            new Date(metadata.created_at) > new Date(latestTask.created_at)
          ) {
            latestTask = {
              task_id: metadata.task_id,
              created_at: metadata.created_at,
            };
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    return latestTask;
  } catch (error) {
    console.error(
      `Failed to find last task for ${repoSlug}#${issueNumber}:`,
      error
    );
    return null;
  }
}

async function getTaskErrorInfo(
  repoSlug: string,
  taskId: string
): Promise<{ error_excerpt: string | null; error_category: string | null; exit_code: number | null }> {
  try {
    const metadataKey = `tasks/${repoSlug}/${taskId}/metadata.json`;
    const metadata = await getTaskMetadata(metadataKey);

    if (!metadata) {
      return { error_excerpt: null, error_category: null, exit_code: null };
    }

    // Get first 200 chars of error message
    const errorExcerpt = metadata.error_message
      ? metadata.error_message.substring(0, 200)
      : null;

    return {
      error_excerpt: errorExcerpt,
      error_category: metadata.failure_category ?? null,
      exit_code: null, // Could read from manifest.json if needed
    };
  } catch (error) {
    console.error(`Failed to get task error info for ${taskId}:`, error);
    return { error_excerpt: null, error_category: null, exit_code: null };
  }
}

async function getAllIssuesWithLabel(
  repo: string,
  label: string,
  token: string
): Promise<any[]> {
  let allIssues: any[] = [];
  let page = 1;

  while (page <= 10) {
    try {
      const response = await githubRequest(
        `/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100&page=${page}`,
        token,
        { method: "GET" },
        [200]
      );

      const issues = await response.json();
      if (!Array.isArray(issues) || issues.length === 0) break;

      allIssues = [...allIssues, ...issues];

      if (issues.length < 100) break;
      page++;
    } catch (error) {
      console.error(`Error fetching issues for ${repo} page ${page}:`, error);
      break;
    }
  }

  return allIssues;
}

async function getAllPRsWithLabel(
  repo: string,
  label: string,
  token: string
): Promise<any[]> {
  let allPRs: any[] = [];
  let page = 1;

  while (page <= 10) {
    try {
      const response = await githubRequest(
        `/repos/${repo}/pulls?labels=${encodeURIComponent(label)}&state=open&per_page=100&page=${page}`,
        token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json();
      if (!Array.isArray(prs) || prs.length === 0) break;

      allPRs = [...allPRs, ...prs];

      if (prs.length < 100) break;
      page++;
    } catch (error) {
      console.error(`Error fetching PRs for ${repo} page ${page}:`, error);
      break;
    }
  }

  return allPRs;
}

async function getCheckRuns(
  repo: string,
  sha: string,
  token: string
): Promise<{ failed: string[]; pending: number; passed: number; total: number }> {
  const result = { failed: [] as string[], pending: 0, passed: 0, total: 0 };

  try {
    const [owner, name] = repo.split("/");
    const response = await githubRequest(
      `/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const data = await response.json() as any;
    const runs = data.check_runs ?? [];

    for (const run of runs) {
      result.total++;
      if (run.status !== "completed") {
        result.pending++;
      } else if (
        run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "cancelled"
      ) {
        result.failed.push(run.name);
      } else if (run.conclusion === "success") {
        result.passed++;
      }
    }
  } catch (error) {
    console.error(`Failed to get check runs for ${repo}@${sha}:`, error);
  }

  return result;
}

function parseBlockerReferences(
  body: string,
  repoOwner: string,
  repoName: string
): Array<{ issue_number: number; repo_owner: string; repo_name: string }> {
  if (!body) return [];

  const references: Array<{
    issue_number: number;
    repo_owner: string;
    repo_name: string;
  }> = [];

  // Same-repo: "Blocked by #123"
  const sameRepoMatches = body.matchAll(/(?:Blocked by)\s+#(\d+)/gi);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: repoOwner,
      repo_name: repoName,
    });
  }

  // Cross-repo: "Blocked by owner/repo#123"
  const crossRepoMatches = body.matchAll(
    /(?:Blocked by)\s+([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/gi
  );
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
    });
  }

  return references;
}

function parseFixesReferences(
  body: string,
  repoOwner: string,
  repoName: string
): Array<{ issue_number: number; repo_owner: string; repo_name: string }> {
  if (!body) return [];

  const references: Array<{
    issue_number: number;
    repo_owner: string;
    repo_name: string;
  }> = [];

  // Same-repo: "Fixes #123", "Closes #456"
  const sameRepoMatches = body.matchAll(/(?:Fixes|Closes|Resolves)\s+#(\d+)/gi);
  for (const match of sameRepoMatches) {
    references.push({
      issue_number: parseInt(match[1], 10),
      repo_owner: repoOwner,
      repo_name: repoName,
    });
  }

  // Cross-repo: "Fixes owner/repo#123"
  const crossRepoMatches = body.matchAll(
    /(?:Fixes|Closes|Resolves)\s+([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/gi
  );
  for (const match of crossRepoMatches) {
    references.push({
      issue_number: parseInt(match[3], 10),
      repo_owner: match[1],
      repo_name: match[2],
    });
  }

  return references;
}

interface FailedIssue {
  number: number;
  title: string;
  labels: string[];
  last_failure_task_id: string | null;
  last_error_excerpt: string | null;
  error_category: string | null;
  github_url: string;
  created_at: string;
  last_updated: string;
}

interface FailedPullRequest {
  number: number;
  title: string;
  labels: string[];
  head_sha: string;
  mergeable: boolean | null;
  check_runs_summary: {
    total: number;
    failed: number;
    pending: number;
    passed: number;
    failed_checks: string[];
  };
  last_failure_task_id: string | null;
  last_error_excerpt: string | null;
  error_category: string | null;
  github_url: string;
  created_at: string;
  last_updated: string;
}

interface CrossReference {
  type: "fixes" | "blocked_by";
  from: { issue_number: number; repo: string; is_pr: boolean };
  to: { issue_number: number; repo: string };
}

interface RepoFailureData {
  repo_slug: string;
  issues: FailedIssue[];
  pull_requests: FailedPullRequest[];
  cross_references: CrossReference[];
  summary: {
    total_failed: number;
    total_waiting: number;
  };
}

interface FailureSnapshot {
  snapshot_id: string;
  collected_at: string;
  repos: Record<string, RepoFailureData>;
}

async function collectFailureData(
  repos: string[],
  appConfig: GitHubAppConfig
): Promise<FailureSnapshot> {
  const snapshot: FailureSnapshot = {
    snapshot_id: `snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    collected_at: new Date().toISOString(),
    repos: {},
  };

  for (const repo of repos) {
    console.log(`Collecting failure data for ${repo}...`);
    const [owner, name] = repo.split("/");

    try {
      const token = await getInstallationToken(owner, name, appConfig);

      // Collect failed issues
      const failedIssuesList = await getAllIssuesWithLabel(
        repo,
        "agent:failed",
        token
      );
      const failedIssues: FailedIssue[] = [];

      for (const issue of failedIssuesList) {
        const lastTask = await findLastTaskForIssue(
          repo,
          issue.number,
          "failed"
        );
        const errorInfo = lastTask
          ? await getTaskErrorInfo(repo, lastTask.task_id)
          : { error_excerpt: null, error_category: null };

        failedIssues.push({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((l: any) => l.name),
          last_failure_task_id: lastTask?.task_id ?? null,
          last_error_excerpt: errorInfo.error_excerpt,
          error_category: errorInfo.error_category,
          github_url: issue.html_url,
          created_at: issue.created_at,
          last_updated: issue.updated_at,
        });
      }

      // Collect waiting issues
      const waitingIssuesList = await getAllIssuesWithLabel(
        repo,
        "agent:waiting",
        token
      );

      // Collect failed/waiting PRs
      const failedPRsList = await getAllPRsWithLabel(
        repo,
        "agent:failed",
        token
      );
      const waitingPRsList = await getAllPRsWithLabel(
        repo,
        "agent:waiting",
        token
      );
      const allPRsList = [...failedPRsList, ...waitingPRsList];

      const failedPRs: FailedPullRequest[] = [];

      for (const pr of allPRsList) {
        const lastTask = await findLastTaskForIssue(
          repo,
          pr.number,
          pr.labels.some((l: any) => l.name === "agent:failed")
            ? "failed"
            : "waiting"
        );
        const errorInfo = lastTask
          ? await getTaskErrorInfo(repo, lastTask.task_id)
          : { error_excerpt: null, error_category: null };

        const checkRuns = await getCheckRuns(repo, pr.head.sha, token);

        failedPRs.push({
          number: pr.number,
          title: pr.title,
          labels: pr.labels.map((l: any) => l.name),
          head_sha: pr.head.sha,
          mergeable: pr.mergeable,
          check_runs_summary: {
            total: checkRuns.total,
            failed: checkRuns.failed.length,
            pending: checkRuns.pending,
            passed: checkRuns.passed,
            failed_checks: checkRuns.failed,
          },
          last_failure_task_id: lastTask?.task_id ?? null,
          last_error_excerpt: errorInfo.error_excerpt,
          error_category: errorInfo.error_category,
          github_url: pr.html_url,
          created_at: pr.created_at,
          last_updated: pr.updated_at,
        });
      }

      // Collect cross-references
      const crossReferences: CrossReference[] = [];

      // From failed issues: blocked by
      for (const issue of failedIssuesList) {
        const blockedBy = parseBlockerReferences(issue.body, owner, name);
        for (const blocker of blockedBy) {
          crossReferences.push({
            type: "blocked_by",
            from: { issue_number: issue.number, repo, is_pr: false },
            to: {
              issue_number: blocker.issue_number,
              repo: `${blocker.repo_owner}/${blocker.repo_name}`,
            },
          });
        }
      }

      // From PRs: fixes
      for (const pr of allPRsList) {
        const fixes = parseFixesReferences(pr.body, owner, name);
        for (const fixed of fixes) {
          crossReferences.push({
            type: "fixes",
            from: { issue_number: pr.number, repo, is_pr: true },
            to: {
              issue_number: fixed.issue_number,
              repo: `${fixed.repo_owner}/${fixed.repo_name}`,
            },
          });
        }
      }

      snapshot.repos[repo] = {
        repo_slug: repo,
        issues: failedIssues,
        pull_requests: failedPRs,
        cross_references: crossReferences,
        summary: {
          total_failed: failedIssues.length,
          total_waiting: waitingIssuesList.length,
        },
      };
    } catch (error) {
      console.error(`Failed to collect data for ${repo}:`, error);
      snapshot.repos[repo] = {
        repo_slug: repo,
        issues: [],
        pull_requests: [],
        cross_references: [],
        summary: { total_failed: 0, total_waiting: 0 },
      };
    }
  }

  return snapshot;
}

async function writeSnapshot(snapshot: FailureSnapshot): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "-");
  const timestampedKey = `unblocker/snapshots/${dateStr}-${timeStr}.json`;
  const latestKey = `unblocker/snapshots/latest.json`;

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  try {
    // Write timestamped snapshot
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: timestampedKey,
        Body: snapshotJson,
        ContentType: "application/json",
      })
    );
    console.log(`Wrote timestamped snapshot to s3://${ARTIFACTS_BUCKET}/${timestampedKey}`);

    // Write latest snapshot
    await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACTS_BUCKET,
        Key: latestKey,
        Body: snapshotJson,
        ContentType: "application/json",
      })
    );
    console.log(`Wrote latest snapshot to s3://${ARTIFACTS_BUCKET}/${latestKey}`);
  } catch (error) {
    console.error("Failed to write snapshot to S3:", error);
    throw error;
  }
}

async function publishMetric(snapshotItemCount: number): Promise<void> {
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: "UnblockerCollector",
        MetricData: [
          {
            MetricName: "SnapshotItems",
            Value: snapshotItemCount,
            Unit: "Count",
            Timestamp: new Date(),
          },
        ],
      })
    );
    console.log(`Published metric UnblockerCollector.SnapshotItems = ${snapshotItemCount}`);
  } catch (error) {
    console.error("Failed to publish CloudWatch metric:", error);
  }
}

export async function handler(): Promise<void> {
  console.log("Starting unblocker failure-graph collector...");

  try {
    // Get GitHub App credentials
    const appId = await getParameter(GITHUB_APP_ID_PARAM);
    const privateKey = await getParameter(GITHUB_APP_PRIVATE_KEY_PARAM);

    const appConfig: GitHubAppConfig = { appId, privateKey };

    // Get monitored repos from environment
    const reposEnv = process.env.MONITORED_REPOS || "";
    const repos = reposEnv
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    if (repos.length === 0) {
      console.warn("No monitored repos configured");
      return;
    }

    console.log(`Collecting data for ${repos.length} repos: ${repos.join(", ")}`);

    // Collect failure data
    const snapshot = await collectFailureData(repos, appConfig);

    // Write snapshot to S3
    await writeSnapshot(snapshot);

    // Calculate total items for metric
    const totalItems = Object.values(snapshot.repos).reduce(
      (sum, data) => sum + data.issues.length + data.pull_requests.length,
      0
    );

    // Publish metric
    await publishMetric(totalItems);

    console.log(`Collector completed. Collected ${totalItems} failed/waiting items.`);
  } catch (error) {
    console.error("Collector failed:", error);
    throw error;
  }
}
