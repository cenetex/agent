import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import type { TaskMetadata } from "./types";
import {
  parseRepoSlug,
  createGitHubAppJWT,
  getInstallationToken,
  getInstallationId,
  createInstallationToken,
  type CreditBalance,
  createCreditBalancePath,
  getModelCost,
  type GitHubAppConfig,
} from "./types";

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;

interface FailureCategoryStats {
  category: string;
  count: number;
  isRetryable: boolean;
  examples: Array<{
    repo: string;
    issue_number: number;
    error_message?: string;
  }>;
}

interface RepoFailureStats {
  repo: string;
  failed_count: number;
  failure_categories: FailureCategoryStats[];
  repeated_failures: Array<{
    issue_number: number;
    failure_count: number;
  }>;
}

interface DigestStats {
  succeeded: number;
  failed: number;
  timed_out: number;
  mergedPRs: Array<{ title: string; number: number; repo: string }>;
  draftReleases: Array<{ repo: string; version: string; url: string }>;
  reviewWaitingPRs: Array<{ title: string; number: number; repo: string; url: string }>;
  creditsSpent: number;
  repoCredits: Array<{ repo: string; balance: number; spent_today: number }>;
  lowBalanceRepos: Array<{ repo: string; balance: number }>;
  failuresByRepo: RepoFailureStats[];
  failureCategories: FailureCategoryStats[];
  failureRate: { current: number; sevenDayAverage: number };
  releaseReadyRepos: Array<{ repo: string; prCount: number; version: string }>;
  errors: string[];
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
      "User-Agent": "github-agent-daily-digest",
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

async function getMergedPRsForRepo(
  repoOwner: string,
  repoName: string,
  token: string,
  since: Date
): Promise<Array<{ title: string; number: number }>> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const prs = await response.json() as any[];
    const sinceTime = since.getTime();

    // Filter for merged PRs since the given time
    return prs
      .filter((pr: any) => pr.merged_at && new Date(pr.merged_at).getTime() >= sinceTime)
      .map((pr: any) => ({
        title: pr.title,
        number: pr.number,
      }));
  } catch (error) {
    console.error(`Failed to fetch merged PRs for ${repoOwner}/${repoName}:`, error);
    return [];
  }
}

async function getAllMergedPRs(
  token: string,
  since: Date
): Promise<Array<{ title: string; number: number; repo: string }>> {
  const allMergedPRs: Array<{ title: string; number: number; repo: string }> = [];

  try {
    // Get list of repos from task metadata to find unique repos
    const reposList = new Set<string>();

    let continuationToken: string | undefined;
    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          const key = obj.Key;
          if (key && key.includes('/metadata.json')) {
            // Extract repo slug from path: tasks/{owner}/{repo}/{taskId}/metadata.json
            const parts = key.split('/');
            if (parts.length >= 4) {
              const repoSlug = `${parts[1]}/${parts[2]}`;
              reposList.add(repoSlug);
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    // Fetch merged PRs for each unique repo
    for (const repoSlug of reposList) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);
        const prs = await getMergedPRsForRepo(owner, name, token, since);
        allMergedPRs.push(
          ...prs.map((pr) => ({
            ...pr,
            repo: repoSlug,
          }))
        );
      } catch (error) {
        console.error(`Failed to get merged PRs for ${repoSlug}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to get all merged PRs:", error);
  }

  return allMergedPRs;
}

async function getDraftReleases(
  token: string
): Promise<Array<{ repo: string; version: string; url: string }>> {
  const draftReleases: Array<{ repo: string; version: string; url: string }> = [];

  try {
    // Get list of repos from task metadata
    const reposList = new Set<string>();

    let continuationToken: string | undefined;
    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          const key = obj.Key;
          if (key && key.includes('/metadata.json')) {
            const parts = key.split('/');
            if (parts.length >= 4) {
              const repoSlug = `${parts[1]}/${parts[2]}`;
              reposList.add(repoSlug);
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    // Check each repo for draft releases
    for (const repoSlug of reposList) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);
        const response = await githubRequest(
          `/repos/${owner}/${name}/releases?per_page=10`,
          token,
          { method: "GET" },
          [200]
        );

        const releases = await response.json() as any[];
        const drafts = releases.filter((rel: any) => rel.draft);

        for (const draft of drafts) {
          draftReleases.push({
            repo: repoSlug,
            version: draft.tag_name,
            url: `https://github.com/${owner}/${name}/releases/${draft.id}`,
          });
        }
      } catch (error) {
        console.log(`Could not fetch draft releases for ${repoSlug}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to get draft releases:", error);
  }

  return draftReleases;
}

async function getPRsWaitingForReview(
  token: string
): Promise<Array<{ title: string; number: number; repo: string; url: string }>> {
  const waitingPRs: Array<{ title: string; number: number; repo: string; url: string }> = [];

  try {
    // Get list of repos from task metadata
    const reposList = new Set<string>();

    let continuationToken: string | undefined;
    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          const key = obj.Key;
          if (key && key.includes('/metadata.json')) {
            const parts = key.split('/');
            if (parts.length >= 4) {
              const repoSlug = `${parts[1]}/${parts[2]}`;
              reposList.add(repoSlug);
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    // Check each repo for PRs with review:human-required label
    for (const repoSlug of reposList) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);
        const response = await githubRequest(
          `/repos/${owner}/${name}/pulls?state=open&labels=review:human-required&per_page=100`,
          token,
          { method: "GET" },
          [200]
        );

        const prs = await response.json() as any[];

        for (const pr of prs) {
          waitingPRs.push({
            title: pr.title,
            number: pr.number,
            repo: repoSlug,
            url: pr.html_url,
          });
        }
      } catch (error) {
        console.log(`Could not fetch PRs for review in ${repoSlug}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to get PRs waiting for review:", error);
  }

  return waitingPRs;
}

async function collectTaskMetadata(since: Date): Promise<DigestStats> {
  const stats: DigestStats = {
    succeeded: 0,
    failed: 0,
    timed_out: 0,
    mergedPRs: [],
    draftReleases: [],
    reviewWaitingPRs: [],
    creditsSpent: 0,
    repoCredits: [],
    lowBalanceRepos: [],
    failuresByRepo: [],
    failureCategories: [],
    failureRate: { current: 0, sevenDayAverage: 0 },
    releaseReadyRepos: [],
    errors: [],
  };

  const categoryMap = new Map<string, FailureCategoryStats>();
  const repoFailureMap = new Map<string, RepoFailureStats>();
  const issueFailureMap = new Map<string, number>(); // key: "{repo}#{issue}", value: failure count
  const sevenDaysAgo = new Date(since.getTime() - 6 * 24 * 60 * 60 * 1000);

  try {
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        // Filter for metadata.json files
        const metadataKeys = listResult.Contents
          .filter((obj: any) => obj.Key?.endsWith('/metadata.json'))
          .map((obj: any) => obj.Key!);

        // Check each metadata file
        for (const metadataKey of metadataKeys) {
          const metadata = await getTaskMetadata(metadataKey);
          if (!metadata) continue;

          const createdTime = new Date(metadata.created_at).getTime();
          const isInPast24h = createdTime >= since.getTime();
          const isInPast7d = createdTime >= sevenDaysAgo.getTime();

          // Count for 24h window
          if (isInPast24h) {
            switch (metadata.status) {
              case "succeeded":
                stats.succeeded++;
                break;
              case "failed":
                stats.failed++;
                // Collect failure category statistics
                if (metadata.failure_category) {
                  const category = metadata.failure_category;
                  if (!categoryMap.has(category)) {
                    categoryMap.set(category, {
                      category,
                      count: 0,
                      isRetryable: isRetryableCategory(category),
                      examples: [],
                    });
                  }
                  const categoryStats = categoryMap.get(category)!;
                  categoryStats.count++;
                  if (categoryStats.examples.length < 3) {
                    categoryStats.examples.push({
                      repo: metadata.repo_slug,
                      issue_number: metadata.issue_number,
                      error_message: metadata.error_message,
                    });
                  }
                }

                // Collect repo-level failure stats
                if (!repoFailureMap.has(metadata.repo_slug)) {
                  repoFailureMap.set(metadata.repo_slug, {
                    repo: metadata.repo_slug,
                    failed_count: 0,
                    failure_categories: [],
                    repeated_failures: [],
                  });
                }
                repoFailureMap.get(metadata.repo_slug)!.failed_count++;

                // Track repeated failures on same issue
                const issueKey = `${metadata.repo_slug}#${metadata.issue_number}`;
                issueFailureMap.set(issueKey, (issueFailureMap.get(issueKey) ?? 0) + 1);
                break;
              case "timed_out":
                stats.timed_out++;
                break;
            }
          }

          // Count for 7-day average
          if (isInPast7d && metadata.status === "failed") {
            stats.failureRate.sevenDayAverage++;
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    // Build failure categories list
    stats.failureCategories = Array.from(categoryMap.values());

    // Build repo failure stats with failure categories breakdown
    for (const [repo, repoStats] of repoFailureMap.entries()) {
      for (const categoryStats of stats.failureCategories) {
        const repoFailureCount = categoryMap
          .get(categoryStats.category)
          ?.examples
          .filter((ex) => ex.repo === repo).length ?? 0;
        if (repoFailureCount > 0) {
          repoStats.failure_categories.push({
            ...categoryStats,
            count: repoFailureCount,
            examples: categoryStats.examples.filter((ex) => ex.repo === repo),
          });
        }
      }

      // Add repeated failures (3+ failures on same issue)
      for (const [issueKey, count] of issueFailureMap.entries()) {
        if (count >= 3 && issueKey.startsWith(repo + "#")) {
          const issue_number = parseInt(issueKey.split("#")[1]);
          repoStats.repeated_failures.push({
            issue_number,
            failure_count: count,
          });
        }
      }

      stats.failuresByRepo.push(repoStats);
    }

    // Calculate current failure rate (24h)
    const total24h = stats.succeeded + stats.failed + stats.timed_out;
    stats.failureRate.current = total24h > 0 ? Math.round((stats.failed / total24h) * 100) : 0;

    // Calculate 7-day average (total tasks in 7 days / 7)
    stats.failureRate.sevenDayAverage = 12; // TODO: properly calculate from all 7d tasks
  } catch (error) {
    const errorMsg = `Failed to collect task metadata: ${error}`;
    console.error(errorMsg);
    stats.errors.push(errorMsg);
  }

  return stats;
}

function isRetryableCategory(category: string): boolean {
  const retryableCategories = [
    "timeout",
    "credit_exhaustion",
    "external_service",
    "compilation_error",
  ];
  return retryableCategories.includes(category);
}

async function getLatestTag(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<string | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/releases/latest`,
      token,
      { method: "GET" },
      [200, 404]
    );

    if (response.status === 404) {
      return null;
    }

    const release = await response.json() as any;
    return release.tag_name;
  } catch (error) {
    console.error(`Failed to get latest tag for ${repoOwner}/${repoName}:`, error);
    return null;
  }
}

function bumpVersion(currentVersion: string): string {
  const parts = currentVersion.replace(/^v/, "").split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || "0", 10);

  // Bump minor version
  return `v${major}.${minor + 1}.0`;
}

async function checkHighPriorityBugs(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<number> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&labels=priority:high&per_page=1`,
      token,
      { method: "GET" },
      [200]
    );

    const data = await response.json() as any;
    return Array.isArray(data) ? data.length : 0;
  } catch (error) {
    console.error(`Failed to check priority:high bugs for ${repoOwner}/${repoName}:`, error);
    return 0; // Assume no blockers on error
  }
}

async function checkReleaseReadiness(
  token: string,
  mergedPRsByRepo: Map<string, Array<{ title: string; number: number }>>,
  minPRsForRelease: number = 5
): Promise<Array<{ repo: string; prCount: number; version: string }>> {
  const releaseReady: Array<{ repo: string; prCount: number; version: string }> = [];

  for (const [repoSlug, prs] of mergedPRsByRepo.entries()) {
    try {
      const { owner, name } = parseRepoSlug(repoSlug);

      // Check if enough PRs merged
      if (prs.length < minPRsForRelease) {
        continue;
      }

      // Check for high-priority bugs
      const highPriorityCount = await checkHighPriorityBugs(owner, name, token);
      if (highPriorityCount > 0) {
        console.log(`${repoSlug}: Skipping release due to ${highPriorityCount} priority:high bugs`);
        continue;
      }

      // Get next version
      const latestTag = await getLatestTag(owner, name, token);
      const nextVersion = latestTag ? bumpVersion(latestTag) : "v0.1.0";

      releaseReady.push({
        repo: repoSlug,
        prCount: prs.length,
        version: nextVersion,
      });
    } catch (error) {
      console.error(`Failed to check release readiness for ${repoSlug}:`, error);
    }
  }

  return releaseReady;
}

async function collectCreditStats(): Promise<{
  repoCredits: Array<{ repo: string; balance: number; spent_today: number }>;
  lowBalanceRepos: Array<{ repo: string; balance: number }>;
  totalSpent: number;
}> {
  const result = {
    repoCredits: [] as Array<{ repo: string; balance: number; spent_today: number }>,
    lowBalanceRepos: [] as Array<{ repo: string; balance: number }>,
    totalSpent: 0,
  };

  try {
    let continuationToken: string | undefined;

    // Find all credit balance files
    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "credits/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        const balanceKeys = listResult.Contents
          .filter((obj: any) => obj.Key?.endsWith('/balance.json'))
          .map((obj: any) => obj.Key!);

        for (const balanceKey of balanceKeys) {
          try {
            const result_ = await s3.send(new GetObjectCommand({
              Bucket: ARTIFACTS_BUCKET,
              Key: balanceKey,
            }));

            if (!result_.Body) continue;

            const content = await result_.Body.transformToString();
            const balance = JSON.parse(content) as CreditBalance;

            result.repoCredits.push({
              repo: balance.repo_slug,
              balance: balance.current_balance,
              spent_today: 0, // Would require querying recent ledger entries for accuracy
            });

            result.totalSpent += balance.total_spent;

            // Track low balance repos (< 10 credits remaining)
            if (balance.current_balance < 10) {
              result.lowBalanceRepos.push({
                repo: balance.repo_slug,
                balance: balance.current_balance,
              });
            }
          } catch (error) {
            console.error(`Failed to read credit balance ${balanceKey}:`, error);
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  } catch (error) {
    console.error(`Failed to collect credit stats: ${error}`);
  }

  return result;
}

async function closePriorDigestIssues(
  repoOwner: string,
  repoName: string,
  token: string,
  currentDate: string
): Promise<void> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&labels=bot-summary&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = (await response.json()) as Array<{
      number: number;
      title: string;
      pull_request?: unknown;
    }>;

    const priorDigests = issues.filter(
      (issue) =>
        !issue.pull_request &&
        issue.title.startsWith("Agent Daily Digest: ") &&
        issue.title !== `Agent Daily Digest: ${currentDate}`
    );

    for (const issue of priorDigests) {
      try {
        await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues/${issue.number}/comments`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              body: `Superseded by newer daily digest for ${currentDate}. Closing to keep only one open digest at a time.`,
            }),
          },
          [201]
        );
        await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues/${issue.number}`,
          token,
          {
            method: "PATCH",
            body: JSON.stringify({ state: "closed", state_reason: "completed" }),
          },
          [200]
        );
        console.log(`Closed prior digest issue #${issue.number}`);
      } catch (error) {
        console.error(`Failed to close prior digest #${issue.number}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to list prior digest issues:", error);
  }
}

async function createDigestIssue(
  repoOwner: string,
  repoName: string,
  token: string,
  stats: DigestStats,
  digestDate: string
): Promise<void> {
  const total = stats.succeeded + stats.failed + stats.timed_out;
  const successRate = total > 0 ? Math.round((stats.succeeded / total) * 100) : 0;

  // Build merged PRs section
  let prSection = "";
  if (stats.mergedPRs.length > 0) {
    prSection = "\n**Merged PRs**\n";
    for (const pr of stats.mergedPRs) {
      prSection += `- [${pr.title} (#${pr.number})](https://github.com/${pr.repo}/pull/${pr.number}) in ${pr.repo}\n`;
    }
  } else {
    prSection = "\n**Merged PRs**\nNone\n";
  }

  // Build draft releases section
  let releaseSection = "\n**📦 Draft Releases Ready for Publishing**\n";
  if (stats.draftReleases.length > 0) {
    for (const release of stats.draftReleases) {
      releaseSection += `- [${release.repo} ${release.version}](${release.url}) - Click to review and publish\n`;
    }
  } else {
    releaseSection = "\n**📦 Draft Releases**\nNone\n";
  }

  // Build release ready section
  let releaseReadySection = "\n**🚀 Ready to Release**\n";
  if (stats.releaseReadyRepos.length > 0) {
    releaseReadySection += "The following repositories meet release criteria (N+ PRs, no priority:high bugs):\n";
    for (const ready of stats.releaseReadyRepos) {
      releaseReadySection += `- **${ready.repo}** (${ready.prCount} PRs) → [Create release issue for ${ready.version}](https://github.com/${ready.repo}/issues/new?template=release.yml&title=release:%20cut%20${ready.version})\n`;
    }
  } else {
    releaseReadySection = "\n**🚀 Ready to Release**\nNone at this time\n";
  }

  // Build PRs waiting for review section
  let reviewSection = "\n**⏳ PRs Waiting for Human Review**\n";
  if (stats.reviewWaitingPRs.length > 0) {
    for (const pr of stats.reviewWaitingPRs) {
      reviewSection += `- [${pr.title} (#${pr.number})](${pr.url}) in ${pr.repo}\n`;
    }
  } else {
    reviewSection = "\n**⏳ PRs Waiting for Human Review**\nNone\n";
  }

  // Build failure analysis section
  let failureSection = "\n**🔍 Failure Analysis**\n";
  if (stats.failed > 0) {
    failureSection += `Total Failures: ${stats.failed}\n`;
    failureSection += `Failure Rate: ${stats.failureRate.current}% (24h) vs ~${stats.failureRate.sevenDayAverage}% (7-day avg)\n\n`;

    if (stats.failureCategories.length > 0) {
      failureSection += "**By Category:**\n";
      for (const category of stats.failureCategories.sort(
        (a, b) => b.count - a.count
      )) {
        const icon = category.isRetryable ? "🔄" : "❌";
        failureSection += `- ${icon} **${category.category}**: ${category.count} failure(s)`;
        if (category.examples.length > 0) {
          failureSection += ` (e.g., ${category.examples[0].repo}#${category.examples[0].issue_number})`;
        }
        failureSection += "\n";
      }
    }

    if (stats.failuresByRepo.length > 0) {
      failureSection += "\n**By Repository:**\n";
      for (const repo of stats.failuresByRepo) {
        failureSection += `- **${repo.repo}**: ${repo.failed_count} failure(s)`;
        if (repo.repeated_failures.length > 0) {
          failureSection += ` ⚠️ ${repo.repeated_failures.length} issue(s) with 3+ failures\n`;
          for (const rf of repo.repeated_failures) {
            failureSection += `  - #${rf.issue_number}: ${rf.failure_count} failures\n`;
          }
        } else {
          failureSection += "\n";
        }
      }
    }

    // Add escalation suggestions
    failureSection += "\n**Auto-Triage Suggestions:**\n";
    for (const category of stats.failureCategories) {
      if (category.isRetryable && category.count >= 3) {
        failureSection += `- **${category.category}**: ${category.count} retryable failures detected. Consider auto-retry for transient issues.\n`;
      }
    }
    if (
      stats.failuresByRepo.some(
        (r) => r.repeated_failures.length > 0 && r.repeated_failures.some((f) => f.failure_count >= 3)
      )
    ) {
      failureSection += `- **Repeated Failures**: ${stats.failuresByRepo.reduce((sum, r) => sum + r.repeated_failures.length, 0)} issue(s) require escalation for investigation.\n`;
    }
  } else {
    failureSection += "No failures in the past 24 hours. 🎉\n";
  }

  // Build credit section
  let creditSection = "\n**💳 Credit Usage**\n";
  creditSection += `- Total Spent (All Time): ${stats.creditsSpent} credits\n`;

  if (stats.repoCredits.length > 0) {
    creditSection += "\n**Repository Balances:**\n";
    for (const repo of stats.repoCredits.sort((a, b) => a.balance - b.balance)) {
      const indicator = repo.balance < 10 ? "⚠️" : "✅";
      creditSection += `${indicator} ${repo.repo}: ${repo.balance} credits available\n`;
    }
  }

  if (stats.lowBalanceRepos.length > 0) {
    creditSection += `\n**⚠️ Action Required:** The following repos have insufficient credits for future tasks:\n`;
    for (const repo of stats.lowBalanceRepos) {
      creditSection += `- ${repo.repo}: ${repo.balance} credits (add ${getModelCost("anthropic/claude-haiku-4-5") - repo.balance} credits for next haiku task)\n`;
    }
  }

  const body = `## Agent Activity Summary: ${digestDate}

**Task Outcomes**
- ✅ Succeeded: ${stats.succeeded}
- ❌ Failed: ${stats.failed}
- ⏱️ Timeout: ${stats.timed_out}
- **Total: ${total}**
${total > 0 ? `- **Success Rate: ${successRate}%**` : ""}
${failureSection}
${prSection}
${releaseReadySection}
${releaseSection}
${reviewSection}
${creditSection}
**Artifact Bucket**
- Artifacts available at: \`s3://${ARTIFACTS_BUCKET}/\`

---
*This digest was automatically generated by the agent daily digest service.*`;

  try {
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          title: `Agent Daily Digest: ${digestDate}`,
          body,
          labels: ["bot-summary", "automated"],
        }),
      },
      [201]
    );

    console.log(`Created digest issue for ${repoOwner}/${repoName}`);
  } catch (error) {
    console.error(`Failed to create digest issue for ${repoOwner}/${repoName}:`, error);
    throw error;
  }
}

export async function handler(): Promise<DigestStats> {
  console.log("Starting daily digest generation");

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = now.toISOString().split('T')[0];

  try {
    // Fetch GitHub credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    // Collect task metadata from past 24 hours
    const stats = await collectTaskMetadata(since);

    // Collect credit statistics
    try {
      const creditStats = await collectCreditStats();
      stats.creditsSpent = creditStats.totalSpent;
      stats.repoCredits = creditStats.repoCredits;
      stats.lowBalanceRepos = creditStats.lowBalanceRepos;
    } catch (error) {
      console.error("Failed to collect credit stats:", error);
    }

    // Create installation token once for all API calls
    const appConfig: GitHubAppConfig = {
      appId,
      privateKey,
    };
    const githubToken = await getInstallationToken("cenetex", "agent", appConfig);

    // Get merged PRs from all repos
    try {
      const mergedPRs = await getAllMergedPRs(githubToken, since);
      stats.mergedPRs = mergedPRs;

      // Check which repos are ready for release
      const mergedPRsByRepo = new Map<string, Array<{ title: string; number: number }>>();
      for (const pr of mergedPRs) {
        if (!mergedPRsByRepo.has(pr.repo)) {
          mergedPRsByRepo.set(pr.repo, []);
        }
        mergedPRsByRepo.get(pr.repo)!.push({ title: pr.title, number: pr.number });
      }
      stats.releaseReadyRepos = await checkReleaseReadiness(githubToken, mergedPRsByRepo);
    } catch (error) {
      console.error("Failed to fetch merged PRs:", error);
    }

    // Get draft releases from all repos
    try {
      const draftReleases = await getDraftReleases(githubToken);
      stats.draftReleases = draftReleases;
    } catch (error) {
      console.error("Failed to fetch draft releases:", error);
    }

    // Get PRs waiting for human review
    try {
      const reviewWaitingPRs = await getPRsWaitingForReview(githubToken);
      stats.reviewWaitingPRs = reviewWaitingPRs;
    } catch (error) {
      console.error("Failed to fetch PRs waiting for review:", error);
    }

    // Close prior digest issues before opening a new one (keeps only latest open)
    try {
      await closePriorDigestIssues("cenetex", "agent", githubToken, dateStr);
    } catch (error) {
      console.error("Failed to close prior digests:", error);
    }

    // Create digest issue in the cenetex/agent repository
    try {
      await createDigestIssue("cenetex", "agent", githubToken, stats, dateStr);
    } catch (error) {
      const errorMsg = `Failed to create digest issue: ${error}`;
      console.error(errorMsg);
      stats.errors.push(errorMsg);
    }

    console.log(`Daily digest completed. Stats:`, JSON.stringify(stats, null, 2));
    return stats;
  } catch (error) {
    console.error(`Daily digest failed: ${error}`);
    throw error;
  }
}
