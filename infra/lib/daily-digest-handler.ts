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
            url: draft.html_url,
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
    errors: [],
  };

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

          // Check if task was completed in the past 24 hours
          const createdTime = new Date(metadata.created_at).getTime();
          if (createdTime >= since.getTime()) {
            switch (metadata.status) {
              case "succeeded":
                stats.succeeded++;
                break;
              case "failed":
                stats.failed++;
                break;
              case "timed_out":
                stats.timed_out++;
                break;
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);
  } catch (error) {
    const errorMsg = `Failed to collect task metadata: ${error}`;
    console.error(errorMsg);
    stats.errors.push(errorMsg);
  }

  return stats;
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

  // Build PRs waiting for review section
  let reviewSection = "\n**⏳ PRs Waiting for Human Review**\n";
  if (stats.reviewWaitingPRs.length > 0) {
    for (const pr of stats.reviewWaitingPRs) {
      reviewSection += `- [${pr.title} (#${pr.number})](${pr.url}) in ${pr.repo}\n`;
    }
  } else {
    reviewSection = "\n**⏳ PRs Waiting for Human Review**\nNone\n";
  }

  // Build credit section
  let creditSection = "\n**💳 Credit Usage**\n";
  creditSection += `- Total Spent (All Time): ${stats.creditsSpent} credits\n`;
  if (stats.lowBalanceRepos.length > 0) {
    creditSection += `- ⚠️ **Low Balance Repos**: ${stats.lowBalanceRepos.map(r => `${r.repo} (${r.balance}cr)`).join(", ")}\n`;
  }

  const body = `## Agent Activity Summary: ${digestDate}

**Task Outcomes**
- ✅ Succeeded: ${stats.succeeded}
- ❌ Failed: ${stats.failed}
- ⏱️ Timeout: ${stats.timed_out}
- **Total: ${total}**
${total > 0 ? `- **Success Rate: ${successRate}%**` : ""}
${prSection}
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
