import {
  ECSClient,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  ReviewPayload,
  PRMetadata,
  generateTaskId,
  parseRepoSlug,
  getInstallationToken,
  createArtifactPrefix,
  PROTECTED_PATHS,
  CODING_AGENT_BOT_LOGINS,
  type ReviewEnvironment,
  type GitHubAppConfig,
} from "./types";
import {
  createRunTaskInput,
  parseTaskAssignPublicIp,
} from "./fargate-task";

const ecs = new ECSClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const REVIEW_TASK_DEFINITION_ARN = process.env.REVIEW_TASK_DEFINITION_ARN!;
const REVIEW_CONTAINER_NAME = process.env.REVIEW_CONTAINER_NAME!;
const SUBNETS = process.env.SUBNETS!;
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const TASK_ASSIGN_PUBLIC_IP = parseTaskAssignPublicIp(process.env.TASK_ASSIGN_PUBLIC_IP);
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const OPENROUTER_API_KEY_PARAM = process.env.OPENROUTER_API_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

// Monitored repositories for automated review (comma-separated)
const MONITORED_REPOS = (process.env.MONITORED_REPOS || "").split(",").filter(r => r.trim());
const DEFAULT_REPOS = [
  "cenetex/aws-swarm",
  "cenetex/kyro",
  "cenetex/raticross",
  "cenetex/ratibot",
  "cenetex/litigation",
  "cenetex/agent",
  "cenetex/governance",
  "atimics/AutoForwarder",
];

// PROTECTED_PATHS and CODING_AGENT_BOT_LOGINS imported from types.ts

interface GitHubLabel {
  name: string;
}

interface GitHubUser {
  login: string;
}

interface GitHubPullRequest {
  number: number;
  title: string;
  body?: string | null;
  labels: GitHubLabel[];
  user: GitHubUser;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
}

interface ReviewablePR extends GitHubPullRequest {
  repo: string;
  githubToken: string;
}

interface GitHubRepository {
  archived?: boolean;
  disabled?: boolean;
}

interface RepoAccess {
  repo: string;
  token: string;
}

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
      "User-Agent": "github-agent-review",
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

function configuredRepos(): string[] {
  return MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repoSkipReason(error: unknown): string | null {
  const message = errorMessage(error);

  if (message.includes("Failed to get installation ID") || message.includes("Not Found")) {
    return "GitHub App is not installed or cannot access this repository.";
  }

  if (
    message.includes("Repository was archived so is read-only") ||
    message.includes("read-only")
  ) {
    return "Repository is archived/read-only.";
  }

  if (message.includes("disabled")) {
    return "Repository is disabled.";
  }

  if (message.includes("Resource not accessible by integration")) {
    return "GitHub App token does not have the permissions required for review scheduling.";
  }

  return null;
}

async function getRepoAccess(repo: string, appConfig: GitHubAppConfig): Promise<RepoAccess | null> {
  try {
    const { owner, name } = parseRepoSlug(repo);
    const token = await getInstallationToken(owner, name, appConfig);
    const response = await githubRequest(
      `/repos/${repo}`,
      token,
      { method: "GET" },
      [200]
    );
    const repoInfo = await response.json() as GitHubRepository;

    if (repoInfo.archived) {
      console.log(`Skipping review repo ${repo}: Repository is archived/read-only.`);
      return null;
    }

    if (repoInfo.disabled) {
      console.log(`Skipping review repo ${repo}: Repository is disabled.`);
      return null;
    }

    return { repo, token };
  } catch (error) {
    const skipReason = repoSkipReason(error);
    if (skipReason) {
      console.log(`Skipping review repo ${repo}: ${skipReason}`);
      return null;
    }
    throw error;
  }
}

/**
 * Discovers open PRs created by the coding agent that need review
 */
async function discoverReviewablePRs(appConfig: GitHubAppConfig): Promise<ReviewablePR[]> {
  console.log("Discovering reviewable PRs...");

  const reviewablePRs: ReviewablePR[] = [];

  for (const repo of configuredRepos()) {
    try {
      console.log(`Checking repository: ${repo}`);
      const repoAccess = await getRepoAccess(repo, appConfig);
      if (!repoAccess) {
        continue;
      }

      const response = await githubRequest(
        `/repos/${repo}/pulls?state=open&per_page=100`,
        repoAccess.token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as GitHubPullRequest[];

      // Filter PRs created by the coding agent that don't have review labels yet
      const needsReview = prs.filter((pr) => {
        const isFromBot = CODING_AGENT_BOT_LOGINS.some(
          login => pr.user.login === login || pr.user.login.includes(login.replace("[bot]", ""))
        );

        const hasReviewLabel = pr.labels.some((label) =>
          label.name.startsWith("review:")
        );

        const hasInProgressLabel = pr.labels.some((label) =>
          label.name === "review:in-progress"
        );

        const hasPauseLabel = pr.labels.some((label) =>
          label.name === "pause-agent"
        );

        return isFromBot && !hasReviewLabel && !hasInProgressLabel && !hasPauseLabel;
      });

      reviewablePRs.push(...needsReview.map(pr => ({
        ...pr,
        repo,
        githubToken: repoAccess.token,
      })));
    } catch (error) {
      const skipReason = repoSkipReason(error);
      if (skipReason) {
        console.log(`Skipping review repo ${repo}: ${skipReason}`);
      } else {
        console.error(`Error checking repository ${repo}:`, error);
      }
      // Continue with other repos
    }
  }

  console.log(`Found ${reviewablePRs.length} PRs needing review`);
  return reviewablePRs;
}

/**
 * Checks for and cleans up stale review:in-progress labels
 * If a review has been in-progress for >90 minutes, something likely crashed
 */
async function cleanupStaleReviewLabels(appConfig: GitHubAppConfig): Promise<void> {
  console.log("Cleaning up stale review:in-progress labels...");

  const STALE_THRESHOLD_MINUTES = 90;

  for (const repo of configuredRepos()) {
    try {
      const repoAccess = await getRepoAccess(repo, appConfig);
      if (!repoAccess) {
        continue;
      }

      // Find all PRs with review:in-progress label
      const response = await githubRequest(
        `/repos/${repo}/issues?labels=review:in-progress&state=open&per_page=100`,
        repoAccess.token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as Array<{ number: number }>;

      for (const pr of prs) {
        // Check when the label was added by looking at recent label events
        const eventsResponse = await githubRequest(
          `/repos/${repo}/issues/${pr.number}/events`,
          repoAccess.token,
          { method: "GET" },
          [200]
        );

        const events = await eventsResponse.json() as any[];
        const labelEvent = events
          .filter((event: any) =>
            event.event === "labeled" &&
            event.label?.name === "review:in-progress"
          )
          .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

        if (!labelEvent) {
          console.log(`PR #${pr.number}: No label event found, skipping`);
          continue;
        }

        const labeledAt = new Date(labelEvent.created_at);
        const now = new Date();
        const minutesSinceLabeled = (now.getTime() - labeledAt.getTime()) / (1000 * 60);

        if (minutesSinceLabeled > STALE_THRESHOLD_MINUTES) {
          console.log(
            `PR #${pr.number}: review:in-progress label is stale (${minutesSinceLabeled.toFixed(0)} minutes old), removing...`
          );

          // Remove the stale label
          await githubRequest(
            `/repos/${repo}/issues/${pr.number}/labels/${encodeURIComponent("review:in-progress")}`,
            repoAccess.token,
            { method: "DELETE" },
            [200, 204, 404]
          );

          // Post a comment about the stale marker
          await githubRequest(
            `/repos/${repo}/issues/${pr.number}/comments`,
            repoAccess.token,
            {
              method: "POST",
              body: JSON.stringify({
                body: `⚠️ **Stale review marker detected and removed**\n\nThe \`review:in-progress\` label was older than 90 minutes, indicating the review task may have crashed. The label has been removed.`
              }),
            },
            [201]
          );
        }
      }
    } catch (error) {
      const skipReason = repoSkipReason(error);
      if (skipReason) {
        console.log(`Skipping stale review cleanup for ${repo}: ${skipReason}`);
      } else {
        console.error(`Error cleaning up stale labels for ${repo}:`, error);
      }
      // Continue with other repos
    }
  }
}

/**
 * Checks if a PR touches protected paths
 */
async function checkProtectedPaths(
  repo: string,
  prNumber: number,
  token: string
): Promise<{ hasProtectedFiles: boolean; protectedFiles: string[] }> {
  try {
    const response = await githubRequest(
      `/repos/${repo}/pulls/${prNumber}/files`,
      token,
      { method: "GET" },
      [200]
    );

    const files = await response.json() as any[];
    const protectedFiles: string[] = [];

    for (const file of files) {
      const filename = file.filename;

      for (const pattern of PROTECTED_PATHS) {
        if (pattern.includes("/") && filename.includes(pattern)) {
          protectedFiles.push(filename);
          break;
        } else if (pattern.includes("*")) {
          const regex = new RegExp(pattern.replace("*", ".*"));
          if (regex.test(filename)) {
            protectedFiles.push(filename);
            break;
          }
        } else if (filename.includes(pattern)) {
          protectedFiles.push(filename);
          break;
        }
      }
    }

    return {
      hasProtectedFiles: protectedFiles.length > 0,
      protectedFiles
    };
  } catch (error) {
    console.error(`Error checking files for PR ${prNumber}:`, error);
    return { hasProtectedFiles: true, protectedFiles: ["Error checking files"] };
  }
}

/**
 * Starts a review task for a PR
 */
async function startReviewTask(
  pr: ReviewablePR,
  openrouterApiKey: string
): Promise<string> {
  const taskId = generateTaskId();
  const repoSlug = pr.repo;
  const githubToken = pr.githubToken;

  const prMetadata: PRMetadata = {
    number: pr.number,
    title: pr.title,
    body: pr.body || "",
    labels: pr.labels.map((label) => label.name),
    author: pr.user.login,
    head_ref: pr.head.ref,
    base_ref: pr.base.ref,
    created_by_bot: true,
  };

  const reviewPayload: ReviewPayload = {
    task_id: taskId,
    repo_slug: repoSlug,
    pr_number: pr.number,
    head_sha: pr.head.sha,
    base_sha: pr.base.sha,
    pr_metadata: prMetadata,
    created_at: new Date().toISOString(),
  };

  const artifactPrefix = createArtifactPrefix(repoSlug, taskId);
  const reviewPayloadS3Key = `${artifactPrefix}/review-payload.json`;

  // Upload review payload to S3 (avoids ECS env var size limit)
  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: reviewPayloadS3Key,
    Body: JSON.stringify(reviewPayload, null, 2),
    ContentType: "application/json",
  }));

  // Add review:in-progress before launch so a label failure cannot create
  // invisible duplicate review tasks.
  await githubRequest(
    `/repos/${repoSlug}/issues/${pr.number}/labels`,
    githubToken,
    {
      method: "POST",
      body: JSON.stringify({ labels: ["review:in-progress"] }),
    },
    [200]
  );
  console.log(`Added review:in-progress label to PR ${repoSlug}#${pr.number}`);

  const reviewCriteria = {
    check_compilation: true,
    check_security: true,
    check_issue_alignment: true,
    check_logic: true,
    check_complexity: true,
    check_cost_impact: true,
    protected_paths: PROTECTED_PATHS,
  };

  const reviewEnvironment: ReviewEnvironment = {
    REVIEW_PAYLOAD_S3_KEY: reviewPayloadS3Key,
    GITHUB_TOKEN: githubToken,
    OPENROUTER_API_KEY: openrouterApiKey,
    ARTIFACTS_BUCKET,
    ARTIFACT_PREFIX: artifactPrefix,
    REPO: repoSlug,
    PR_NUMBER: pr.number.toString(),
    REVIEW_CRITERIA: JSON.stringify(reviewCriteria),
  };

  const params = createRunTaskInput({
    clusterArn: CLUSTER_ARN,
    taskDefinitionArn: REVIEW_TASK_DEFINITION_ARN,
    containerName: REVIEW_CONTAINER_NAME,
    subnets: SUBNETS,
    securityGroup: SECURITY_GROUP,
    environment: { ...reviewEnvironment },
    assignPublicIp: TASK_ASSIGN_PUBLIC_IP,
  });

  let taskArn: string | undefined;

  try {
    const result = await ecs.send(new RunTaskCommand(params));
    taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn || (result.failures?.length ?? 0) > 0) {
      const failureDetails =
        result.failures?.map((failure) => failure.reason ?? failure.arn ?? "unknown failure") ??
        [];
      throw new Error(
        failureDetails.length > 0
          ? `Review task launch failed: ${failureDetails.join(", ")}`
          : "Review task launch did not return a task ARN"
      );
    }
  } catch (error) {
    try {
      await githubRequest(
        `/repos/${repoSlug}/issues/${pr.number}/labels/${encodeURIComponent("review:in-progress")}`,
        githubToken,
        { method: "DELETE" },
        [200, 204, 404]
      );
    } catch (cleanupError) {
      console.warn(
        `Failed to remove review:in-progress after launch failure for ${repoSlug}#${pr.number}: ${errorMessage(cleanupError)}`
      );
    }
    throw error;
  }

  if (!taskArn) {
    throw new Error("Review task launch did not return a task ARN");
  }

  // Store initial review metadata
  const metadata = {
    task_id: taskId,
    pr_number: pr.number,
    repo_slug: repoSlug,
    status: "running",
    task_arn: taskArn,
    review_payload_s3_key: reviewPayloadS3Key,
    created_at: reviewPayload.created_at,
    started_at: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: `${artifactPrefix}/review-metadata.json`,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: "application/json",
  }));

  console.log(`Started review task ${taskId} for PR ${pr.number} (${taskArn})`);
  return taskArn;
}

/**
 * Main handler function triggered by EventBridge
 */
export async function handler() {
  console.log("Review handler triggered");

  try {
    // Get credentials
    const [appId, privateKey, openrouterApiKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      getParameter(OPENROUTER_API_KEY_PARAM),
    ]);

    const appConfig: GitHubAppConfig = {
      appId,
      privateKey,
    };

    // Clean up stale review:in-progress labels from crashed reviews
    await cleanupStaleReviewLabels(appConfig);

    // Discover reviewable PRs
    const reviewablePRs = await discoverReviewablePRs(appConfig);

    // Merge execution is owned by merge-triage-handler.ts so approved PRs are
    // ordered against the rest of the repository queue before anything lands.

    if (reviewablePRs.length === 0) {
      console.log("No PRs need review at this time");
      return { statusCode: 200, body: "No PRs to review" };
    }

    // Process each PR
    const results = [];
    for (const pr of reviewablePRs) {
      try {
        // Check if PR touches protected paths
        const { hasProtectedFiles, protectedFiles } = await checkProtectedPaths(
          pr.repo,
          pr.number,
          pr.githubToken
        );

        if (hasProtectedFiles) {
          console.log(`PR ${pr.number} touches protected files: ${protectedFiles.join(", ")}`);

          // Add a comment and label for human review
          await githubRequest(
            `/repos/${pr.repo}/issues/${pr.number}/comments`,
            pr.githubToken,
            {
              method: "POST",
              body: JSON.stringify({
                body: `🛡️ **Protected files detected**

This PR modifies files that require human review:
${protectedFiles.map(f => `- \`${f}\``).join("\n")}

This PR will not be auto-merged and needs manual review.`
              }),
            },
            [201]
          );

          await githubRequest(
            `/repos/${pr.repo}/issues/${pr.number}/labels`,
            pr.githubToken,
            {
              method: "POST",
              body: JSON.stringify({ labels: ["review:human-required"] }),
            },
            [200]
          );

          results.push({
            repo: pr.repo,
            pr: pr.number,
            status: "protected-files",
            protectedFiles
          });
          continue;
        }

        // Start review task
        const taskArn = await startReviewTask(pr, openrouterApiKey);

        results.push({
          repo: pr.repo,
          pr: pr.number,
          status: "review-started",
          taskArn
        });

      } catch (error) {
        console.error(`Failed to process PR ${pr.number}:`, error);
        results.push({
          repo: pr.repo,
          pr: pr.number,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Review handler completed",
        processed: results.length,
        results
      }),
    };

  } catch (error) {
    console.error("Review handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
}
