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
  createRepoSlug,
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
import {
  hasCurrentHumanApproval,
  hasBlockingAutoMergeLabel,
} from "./review-policy";

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

/**
 * Discovers open PRs created by the coding agent that need review
 */
async function discoverReviewablePRs(token: string): Promise<any[]> {
  console.log("Discovering reviewable PRs...");

  // Get all open PRs across monitored repositories
  // The repo list is configured via MONITORED_REPOS environment variable
  const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;

  const reviewablePRs: any[] = [];

  for (const repo of repos) {
    try {
      console.log(`Checking repository: ${repo}`);

      const response = await githubRequest(
        `/repos/${repo}/pulls?state=open&per_page=100`,
        token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as any[];

      // Filter PRs created by the coding agent that don't have review labels yet
      const needsReview = prs.filter((pr: any) => {
        const isFromBot = CODING_AGENT_BOT_LOGINS.some(
          login => pr.user.login === login || pr.user.login.includes(login.replace("[bot]", ""))
        );

        const hasReviewLabel = pr.labels.some((label: any) =>
          label.name.startsWith("review:")
        );

        const hasInProgressLabel = pr.labels.some((label: any) =>
          label.name === "review:in-progress"
        );

        const hasPauseLabel = pr.labels.some((label: any) =>
          label.name === "pause-agent"
        );

        return isFromBot && !hasReviewLabel && !hasInProgressLabel && !hasPauseLabel;
      });

      reviewablePRs.push(...needsReview.map(pr => ({ ...pr, repo })));
    } catch (error) {
      console.error(`Error checking repository ${repo}:`, error);
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
async function cleanupStaleReviewLabels(token: string): Promise<void> {
  console.log("Cleaning up stale review:in-progress labels...");

  const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;

  const STALE_THRESHOLD_MINUTES = 90;

  for (const repo of repos) {
    try {
      // Find all PRs with review:in-progress label
      const response = await githubRequest(
        `/repos/${repo}/issues?labels=review:in-progress&state=open&per_page=100`,
        token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as any[];

      for (const pr of prs) {
        // Check when the label was added by looking at recent label events
        const eventsResponse = await githubRequest(
          `/repos/${repo}/issues/${pr.number}/events`,
          token,
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
            token,
            { method: "DELETE" },
            [200, 204, 404]
          );

          // Post a comment about the stale marker
          await githubRequest(
            `/repos/${repo}/issues/${pr.number}/comments`,
            token,
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
      console.error(`Error cleaning up stale labels for ${repo}:`, error);
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
  pr: any,
  githubToken: string,
  openrouterApiKey: string
): Promise<string> {
  const taskId = generateTaskId();
  const repoSlug = pr.repo;

  const prMetadata: PRMetadata = {
    number: pr.number,
    title: pr.title,
    body: pr.body || "",
    labels: pr.labels.map((label: any) => label.name),
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

  const result = await ecs.send(new RunTaskCommand(params));
  const taskArn = result.tasks?.[0]?.taskArn;

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

  // Add review:in-progress label to prevent duplicate review launches
  const [repoOwner, repoName] = repoSlug.split("/");
  try {
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues/${pr.number}/labels`,
      githubToken,
      {
        method: "POST",
        body: JSON.stringify({ labels: ["review:in-progress"] }),
      },
      [200]
    );
    console.log(`Added review:in-progress label to PR ${pr.number}`);
  } catch (labelError) {
    console.warn(`Failed to add review:in-progress label to PR ${pr.number}: ${labelError}`);
    // Don't fail task launch if label addition fails
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
 * Merges PRs with review:approved label that have been approved for >1 hour
 */
async function mergeApprovedPRs(token: string): Promise<void> {
  console.log("Checking for PRs ready for auto-merge...");

  const repos = MONITORED_REPOS.length > 0 ? MONITORED_REPOS : DEFAULT_REPOS;

  for (const repo of repos) {
    try {
      console.log(`Checking repository for approved PRs: ${repo}`);

      const response = await githubRequest(
        `/repos/${repo}/pulls?state=open&per_page=100`,
        token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as any[];

      // Filter PRs with review:approved label
      const approvedPRs = prs.filter((pr: any) => {
        const labels = pr.labels.map((label: any) => label.name);
        const hasApprovedLabel = pr.labels.some((label: any) =>
          label.name === "review:approved"
        );

        return hasApprovedLabel && !hasBlockingAutoMergeLabel(labels);
      });

      for (const pr of approvedPRs) {
        try {
          const reviewsResponse = await githubRequest(
            `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
            token,
            { method: "GET" },
            [200]
          );
          const reviews = await reviewsResponse.json() as any[];
          const hasHumanApproval = hasCurrentHumanApproval(reviews);

          if (!hasHumanApproval) {
            console.log(`PR ${pr.number}: review:approved label exists but no human approving review was found, skipping auto-merge`);
            continue;
          }

          // Get the label events to check when review:approved was added
          const labelsResponse = await githubRequest(
            `/repos/${repo}/issues/${pr.number}/events`,
            token,
            { method: "GET" },
            [200]
          );

          const events = await labelsResponse.json() as any[];

          // Find the most recent "labeled" event for "review:approved"
          const approvedEvent = events
            .filter((event: any) =>
              event.event === "labeled" &&
              event.label?.name === "review:approved"
            )
            .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

          if (!approvedEvent) {
            console.log(`PR ${pr.number}: No review:approved label event found, skipping`);
            continue;
          }

          const labeledAt = new Date(approvedEvent.created_at);
          const now = new Date();
          const hoursSinceApproval = (now.getTime() - labeledAt.getTime()) / (1000 * 60 * 60);

          if (hoursSinceApproval < 1) {
            console.log(`PR ${pr.number}: Only ${hoursSinceApproval.toFixed(2)} hours since approval, waiting`);
            continue;
          }

          console.log(`PR ${pr.number}: ${hoursSinceApproval.toFixed(2)} hours since approval, merging...`);

          // Attempt to merge the PR
          const mergeResponse = await githubRequest(
            `/repos/${repo}/pulls/${pr.number}/merge`,
            token,
            {
              method: "PUT",
              body: JSON.stringify({
                commit_title: `Auto-merge: ${pr.title}`,
                commit_message: `Auto-merged by review agent after 1-hour hold period.`,
                merge_method: "squash"
              })
            },
            [200]
          );

          const mergeResult = await mergeResponse.json() as any;

          if (mergeResult.merged) {
            console.log(`Successfully auto-merged PR ${pr.number}: ${pr.title}`);

            // Add a final comment
            await githubRequest(
              `/repos/${repo}/issues/${pr.number}/comments`,
              token,
              {
                method: "POST",
                body: JSON.stringify({
                  body: `✅ **Auto-merged successfully**\n\nThis PR was automatically merged after the 1-hour hold period.\n\n🔗 **Merge SHA:** \`${mergeResult.sha}\``
                }),
              },
              [201]
            );
          }

        } catch (error) {
          console.error(`Error auto-merging PR ${pr.number}:`, error);

          // Add comment about merge failure
          try {
            await githubRequest(
              `/repos/${repo}/issues/${pr.number}/comments`,
              token,
              {
                method: "POST",
                body: JSON.stringify({
                  body: `⚠️ **Auto-merge failed**\n\nThe automatic merge failed. Manual intervention required.\n\n**Error:** ${error instanceof Error ? error.message : "Unknown error"}`
                }),
              },
              [201]
            );
          } catch (commentError) {
            console.error(`Failed to add merge failure comment:`, commentError);
          }
        }
      }

    } catch (error) {
      console.error(`Error checking repository ${repo} for auto-merge:`, error);
    }
  }
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

    // For simplicity, we'll get a token for a known repo
    // In full implementation, this would iterate over all installations
    const githubToken = await getInstallationToken("cenetex", "agent", appConfig);

    // Clean up stale review:in-progress labels from crashed reviews
    await cleanupStaleReviewLabels(githubToken);

    // Discover reviewable PRs
    const reviewablePRs = await discoverReviewablePRs(githubToken);

    // After discovering and reviewing new PRs, also merge approved ones
    await mergeApprovedPRs(githubToken);

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
          githubToken
        );

        if (hasProtectedFiles) {
          console.log(`PR ${pr.number} touches protected files: ${protectedFiles.join(", ")}`);

          // Add a comment and label for human review
          await githubRequest(
            `/repos/${pr.repo}/issues/${pr.number}/comments`,
            githubToken,
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
            githubToken,
            {
              method: "POST",
              body: JSON.stringify({ labels: ["review:human-required"] }),
            },
            [200]
          );

          results.push({
            pr: pr.number,
            status: "protected-files",
            protectedFiles
          });
          continue;
        }

        // Start review task
        const taskArn = await startReviewTask(pr, githubToken, openrouterApiKey);

        results.push({
          pr: pr.number,
          status: "review-started",
          taskArn
        });

      } catch (error) {
        console.error(`Failed to process PR ${pr.number}:`, error);
        results.push({
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
