import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { TaskMetadata } from "../types";
import {
  createGitHubAppJWT,
  getInstallationToken,
  getInstallationId,
  createInstallationToken,
  type GitHubAppConfig,
} from "../types";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const cloudwatch = new CloudWatchClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

interface FailedIssue {
  number: number;
  title: string;
  labels: string[];
  last_failure_task_id: string;
  last_error_excerpt: string;
  exit_code?: number;
  failure_category?: string;
}

interface FailedPR {
  number: number;
  head_sha: string;
  mergeable: boolean | null;
  check_runs_summary: {
    total: number;
    completed: number;
    conclusion?: string;
  };
  last_failure_task_id: string;
  last_error_excerpt: string;
  exit_code?: number;
  failure_category?: string;
}

interface CrossReference {
  issue_number: number;
  fixing_pr?: number;
  blocked_by?: number[];
}

interface RepoSnapshot {
  repo: string;
  timestamp: string;
  failed_issues: FailedIssue[];
  failed_or_waiting_prs: FailedPR[];
  cross_references: CrossReference[];
}

interface FailureGraphSnapshot {
  timestamp: string;
  generated_at: string;
  repos: RepoSnapshot[];
  item_count: number;
}

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

async function getTaskMetadata(metadataKey: string): Promise<TaskMetadata | null> {
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: metadataKey,
    }));

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as TaskMetadata;
  } catch (error) {
    console.error(`Failed to get metadata ${metadataKey}:`, error);
    return null;
  }
}

async function getLastTaskMetadataForIssue(
  repoSlug: string,
  issueNumber: number,
  status: "failed" | "waiting"
): Promise<{ taskId: string; metadata: TaskMetadata } | null> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACTS_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    if (!listResult.Contents) return null;

    const taskFolders = listResult.Contents
      .map(obj => obj.Key?.split("/")[2])
      .filter(id => id)
      .filter((id, idx, arr) => arr.indexOf(id) === idx);

    for (const taskId of taskFolders.reverse()) {
      if (!taskId) continue;
      const metadataKey = `tasks/${repoSlug}/${taskId}/metadata.json`;
      const metadata = await getTaskMetadata(metadataKey);
      if (metadata && metadata.issue_number === issueNumber &&
          (status === "failed" ? metadata.status === "failed" : metadata.status === "waiting")) {
        return { taskId, metadata };
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to get last task metadata for ${repoSlug}#${issueNumber}:`, error);
    return null;
  }
}

async function getLastTaskMetadataForPR(
  repoSlug: string,
  prNumber: number,
  statuses: ("failed" | "waiting")[]
): Promise<{ taskId: string; metadata: TaskMetadata } | null> {
  try {
    const prefix = `tasks/${repoSlug}/`;
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: ARTIFACTS_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
    }));

    if (!listResult.Contents) return null;

    const taskFolders = listResult.Contents
      .map(obj => obj.Key?.split("/")[2])
      .filter(id => id)
      .filter((id, idx, arr) => arr.indexOf(id) === idx);

    for (const taskId of taskFolders.reverse()) {
      if (!taskId) continue;
      const metadataKey = `tasks/${repoSlug}/${taskId}/metadata.json`;
      const metadata = await getTaskMetadata(metadataKey);
      if (metadata && metadata.issue_number === prNumber &&
          statuses.includes(metadata.status as any) &&
          metadata.task_mode === "pull_request") {
        return { taskId, metadata };
      }
    }

    return null;
  } catch (error) {
    console.error(`Failed to get last task metadata for PR ${repoSlug}#${prNumber}:`, error);
    return null;
  }
}

async function getLogExcerpt(taskId: string, repoSlug: string): Promise<string> {
  try {
    const logKey = `tasks/${repoSlug}/${taskId}/agent.log`;
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: logKey,
    }));

    if (!result.Body) return "";

    const content = await result.Body.transformToString();
    const lines = content.split("\n");
    const last50 = lines.slice(Math.max(0, lines.length - 50)).join("\n");
    return last50.substring(0, 500);
  } catch (error) {
    console.error(`Failed to get log excerpt for ${taskId}:`, error);
    return "";
  }
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

async function collectFailedIssues(
  repoOwner: string,
  repoName: string,
  token: string,
  repoSlug: string
): Promise<FailedIssue[]> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?labels=agent:failed&state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];
    const failedIssues: FailedIssue[] = [];

    for (const issue of issues) {
      const taskData = await getLastTaskMetadataForIssue(repoSlug, issue.number, "failed");
      if (taskData) {
        const excerpt = await getLogExcerpt(taskData.taskId, repoSlug);
        failedIssues.push({
          number: issue.number,
          title: issue.title,
          labels: issue.labels.map((l: any) => l.name),
          last_failure_task_id: taskData.taskId,
          last_error_excerpt: excerpt,
          exit_code: taskData.metadata.exit_code,
          failure_category: taskData.metadata.failure_category,
        });
      }
    }

    return failedIssues;
  } catch (error) {
    console.error(`Failed to collect failed issues for ${repoSlug}:`, error);
    return [];
  }
}

async function collectFailedOrWaitingPRs(
  repoOwner: string,
  repoName: string,
  token: string,
  repoSlug: string
): Promise<FailedPR[]> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls?state=open&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const prs = await response.json() as any[];
    const failedPRs: FailedPR[] = [];

    for (const pr of prs) {
      const labels = pr.labels.map((l: any) => l.name);
      if (!labels.includes("agent:failed") && !labels.includes("agent:waiting")) {
        continue;
      }

      const statuses = labels.includes("agent:failed") ? ["failed"] : ["waiting"];
      const taskData = await getLastTaskMetadataForPR(repoSlug, pr.number, statuses as any);

      if (taskData) {
        const excerpt = await getLogExcerpt(taskData.taskId, repoSlug);

        // Get check runs summary
        let checkRunsSummary = { total: 0, completed: 0, conclusion: undefined };
        try {
          const checksResponse = await githubRequest(
            `/repos/${repoOwner}/${repoName}/commits/${pr.head.sha}/check-runs`,
            token,
            { method: "GET" },
            [200]
          );
          const checksData = await checksResponse.json() as any;
          if (checksData.check_runs) {
            checkRunsSummary.total = checksData.check_runs.length;
            checkRunsSummary.completed = checksData.check_runs.filter((c: any) => c.status === "completed").length;
            const conclusions = checksData.check_runs.map((c: any) => c.conclusion).filter((c: any) => c);
            checkRunsSummary.conclusion = conclusions[0];
          }
        } catch (e) {
          console.error(`Failed to get check runs for ${repoSlug}#${pr.number}:`, e);
        }

        failedPRs.push({
          number: pr.number,
          head_sha: pr.head.sha,
          mergeable: pr.mergeable,
          check_runs_summary: checkRunsSummary,
          last_failure_task_id: taskData.taskId,
          last_error_excerpt: excerpt,
          exit_code: taskData.metadata.exit_code,
          failure_category: taskData.metadata.failure_category,
        });
      }
    }

    return failedPRs;
  } catch (error) {
    console.error(`Failed to collect failed/waiting PRs for ${repoSlug}:`, error);
    return [];
  }
}

async function collectCrossReferences(
  repoOwner: string,
  repoName: string,
  token: string,
  failedIssues: FailedIssue[]
): Promise<CrossReference[]> {
  try {
    const references: CrossReference[] = [];

    for (const issue of failedIssues) {
      const ref: CrossReference = {
        issue_number: issue.number,
      };

      // Get issue body to find cross-references
      const response = await githubRequest(
        `/repos/${repoOwner}/${repoName}/issues/${issue.number}`,
        token,
        { method: "GET" },
        [200]
      );

      const issueData = await response.json() as any;
      const body = issueData.body || "";

      // Find "Fixes #N" patterns
      const fixesMatch = body.match(/[Ff]ixes\s+#(\d+)/);
      if (fixesMatch) {
        ref.fixing_pr = parseInt(fixesMatch[1], 10);
      }

      // Find "blocked by #N" patterns
      const blockedMatches = body.matchAll(/[Bb]locked\s+by\s+#(\d+)/g);
      const blocked = [];
      for (const match of blockedMatches) {
        blocked.push(parseInt(match[1], 10));
      }
      if (blocked.length > 0) {
        ref.blocked_by = blocked;
      }

      if (ref.fixing_pr || ref.blocked_by) {
        references.push(ref);
      }
    }

    return references;
  } catch (error) {
    console.error(`Failed to collect cross-references:`, error);
    return [];
  }
}

async function collectRepoSnapshot(
  repoOwner: string,
  repoName: string,
  token: string,
  repoSlug: string
): Promise<RepoSnapshot> {
  console.log(`Collecting snapshot for ${repoSlug}...`);

  const failedIssues = await collectFailedIssues(repoOwner, repoName, token, repoSlug);
  const failedOrWaitingPRs = await collectFailedOrWaitingPRs(repoOwner, repoName, token, repoSlug);
  const crossReferences = await collectCrossReferences(repoOwner, repoName, token, failedIssues);

  return {
    repo: repoSlug,
    timestamp: new Date().toISOString(),
    failed_issues: failedIssues,
    failed_or_waiting_prs: failedOrWaitingPRs,
    cross_references: crossReferences,
  };
}

export async function handler(): Promise<void> {
  console.log("Starting failure-graph collector...");

  try {
    // Get GitHub App credentials
    const appId = await getParameter(GITHUB_APP_ID_PARAM);
    const privateKey = await getParameter(GITHUB_APP_PRIVATE_KEY_PARAM);

    const appConfig: GitHubAppConfig = { appId, privateKey };

    // List of repositories to monitor
    const repos = [
      "cenetex/aws-swarm",
      "cenetex/kyro",
      "cenetex/raticross",
      "cenetex/ratibot",
      "cenetex/litigation",
      "cenetex/agent",
      "cenetex/governance",
    ];

    const repoSnapshots: RepoSnapshot[] = [];
    let totalItems = 0;

    for (const repo of repos) {
      const [owner, name] = repo.split("/");
      try {
        const token = await getInstallationToken(owner, name, appConfig);
        const snapshot = await collectRepoSnapshot(owner, name, token, repo);
        repoSnapshots.push(snapshot);
        totalItems += snapshot.failed_issues.length + snapshot.failed_or_waiting_prs.length;
      } catch (error) {
        console.error(`Failed to collect snapshot for ${repo}:`, error);
      }
    }

    // Create snapshot
    const now = new Date();
    const timestamp = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const timeComponent = `${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;

    const snapshot: FailureGraphSnapshot = {
      timestamp: `${timestamp}-${timeComponent}`,
      generated_at: new Date().toISOString(),
      repos: repoSnapshots,
      item_count: totalItems,
    };

    // Write snapshot to S3
    const key = `unblocker/snapshots/${timestamp}-${timeComponent}.json`;
    const latestKey = "unblocker/snapshots/latest.json";

    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: key,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: "application/json",
    }));

    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: latestKey,
      Body: JSON.stringify(snapshot, null, 2),
      ContentType: "application/json",
    }));

    console.log(`Snapshot written to s3://${ARTIFACTS_BUCKET}/${key}`);

    // Publish CloudWatch metric
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: "UnblockerCollector",
      MetricData: [
        {
          MetricName: "SnapshotItems",
          Value: totalItems,
          Unit: "Count",
          Timestamp: now,
        },
      ],
    }));

    console.log(`Published metric: SnapshotItems=${totalItems}`);
  } catch (error) {
    console.error("Failure-graph collector failed:", error);
    throw error;
  }
}
