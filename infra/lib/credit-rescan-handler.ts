/**
 * Credit Rescan Handler
 *
 * Scans for issues blocked due to insufficient credits and retries them
 * when credits become available. Can be triggered manually or via webhook.
 *
 * Triggered when:
 * - Manual trigger: Lambda invoked by user action or cron job
 * - Webhook: credits/{owner}/{repo}/balance.json is updated with higher balance
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  type CreditBalance,
  parseRepoSlug,
  createRepoSlug,
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
  getModelCost,
  type GitHubAppConfig,
} from "./types";

const s3 = new S3Client({});
const ssm = new SSMClient({});

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
      "User-Agent": "github-agent-credit-rescan",
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
      return null;
    }
    throw error;
  }
}

async function getInstallationToken(
  repoOwner: string,
  repoName: string,
  appConfig: GitHubAppConfig
): Promise<string> {
  const jwt = createGitHubAppJWT(appConfig.appId, appConfig.privateKey);
  const installationId = await getInstallationId(repoOwner, repoName, jwt);
  const tokenResponse = await createInstallationToken(installationId, jwt);
  return tokenResponse.token;
}

interface BlockedIssue {
  repo: string;
  owner: string;
  number: number;
  title: string;
  requiredCredits: number;
  currentBalance: number;
}

async function findBlockedIssues(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<BlockedIssue[]> {
  try {
    // Query for issues with status:blocked. Credit rejection removes the trigger
    // label, so requiring `agent` here leaves blocked issues stranded.
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/issues?state=open&labels=status%3Ablocked&per_page=100`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];
    const blockedIssues: BlockedIssue[] = [];

    for (const issue of issues) {
      // Parse the most recent comment to extract required credits
      try {
        const commentsResponse = await githubRequest(
          `/repos/${repoOwner}/${repoName}/issues/${issue.number}/comments?sort=created&direction=desc&per_page=1`,
          token,
          { method: "GET" },
          [200, 404]
        );

        if (commentsResponse.status === 200) {
          const comments = await commentsResponse.json() as any[];
          if (comments.length > 0) {
            const lastComment = comments[0].body || "";
            // Extract "Required: X credits" from the comment
            const requiredMatch = lastComment.match(/Required:\s*(\d+)\s*credits/);
            const availableMatch = lastComment.match(/Available:\s*(\d+)\s*credits/);

            if (requiredMatch && availableMatch) {
              blockedIssues.push({
                repo: `${repoOwner}/${repoName}`,
                owner: repoOwner,
                number: issue.number,
                title: issue.title,
                requiredCredits: parseInt(requiredMatch[1], 10),
                currentBalance: parseInt(availableMatch[1], 10),
              });
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to parse blocked issue ${issue.number}:`, error);
      }
    }

    return blockedIssues;
  } catch (error) {
    console.error(`Failed to find blocked issues for ${repoOwner}/${repoName}:`, error);
    return [];
  }
}

async function removeLabel(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    token,
    { method: "DELETE" },
    [200, 204, 404]
  );
}

async function addIssueComment(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  body: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );
}

async function retryBlockedIssue(
  blockedIssue: BlockedIssue,
  token: string
): Promise<boolean> {
  try {
    const repoSlug = createRepoSlug(blockedIssue.owner, blockedIssue.repo.split("/")[1]);
    const balance = await getCreditBalance(repoSlug);

    if (!balance || balance.current_balance < blockedIssue.requiredCredits) {
      console.log(
        `Issue #${blockedIssue.number} still blocked: needs ${blockedIssue.requiredCredits}, has ${balance?.current_balance ?? 0}`
      );
      return false;
    }

    console.log(
      `Credits now available for issue #${blockedIssue.number}: ${balance.current_balance} >= ${blockedIssue.requiredCredits}`
    );

    // Remove status:blocked label
    await removeLabel(
      blockedIssue.owner,
      blockedIssue.repo.split("/")[1],
      blockedIssue.number,
      token,
      "status:blocked"
    );

    await removeLabel(
      blockedIssue.owner,
      blockedIssue.repo.split("/")[1],
      blockedIssue.number,
      token,
      "agent:running"
    );

    // Post a comment about credits now being available
    await addIssueComment(
      blockedIssue.owner,
      blockedIssue.repo.split("/")[1],
      blockedIssue.number,
      token,
      `✅ **Credits now available**

Your repository now has sufficient credits to run this task!

- Required: ${blockedIssue.requiredCredits} credits
- Available: ${balance.current_balance} credits

The \`status:blocked\` label has been removed. Re-adding the \`agent\` label will trigger the task.`
    );

    console.log(`Unblocked issue #${blockedIssue.number}`);
    return true;
  } catch (error) {
    console.error(`Failed to retry blocked issue #${blockedIssue.number}:`, error);
    return false;
  }
}

interface RescanResult {
  scannedRepos: number;
  unblocked: number;
  stillBlocked: number;
  errors: string[];
}

async function scanRepositoriesForBlockedIssues(
  appConfig: GitHubAppConfig
): Promise<RescanResult> {
  const result: RescanResult = {
    scannedRepos: 0,
    unblocked: 0,
    stillBlocked: 0,
    errors: [],
  };

  try {
    // Find all unique repositories that have credit balances
    const repoSlugs = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "credits/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        for (const obj of listResult.Contents) {
          if (obj.Key?.endsWith("/balance.json")) {
            // Extract repo slug from path: credits/{owner}/{repo}/balance.json
            const parts = obj.Key.split("/");
            if (parts.length >= 3) {
              const repoSlug = `${parts[1]}/${parts[2]}`;
              repoSlugs.add(repoSlug);
            }
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

    console.log(`Found ${repoSlugs.size} repositories with credit balances`);

    // Scan each repository for blocked issues
    for (const repoSlug of Array.from(repoSlugs)) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);
        result.scannedRepos++;

        // Get installation token for this repo
        const githubToken = await getInstallationToken(owner, name, appConfig);

        // Find blocked issues in this repo
        const blockedIssues = await findBlockedIssues(owner, name, githubToken);

        if (blockedIssues.length === 0) {
          console.log(`No blocked issues in ${repoSlug}`);
          continue;
        }

        console.log(`Found ${blockedIssues.length} blocked issue(s) in ${repoSlug}`);

        // Try to unblock each issue
        for (const blockedIssue of blockedIssues) {
          const unblocked = await retryBlockedIssue(blockedIssue, githubToken);
          if (unblocked) {
            result.unblocked++;
          } else {
            result.stillBlocked++;
          }
        }
      } catch (error) {
        const errorMsg = `Failed to scan ${repoSlug}: ${error}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }
  } catch (error) {
    const errorMsg = `Failed to scan repositories: ${error}`;
    console.error(errorMsg);
    result.errors.push(errorMsg);
  }

  return result;
}

export async function handler(): Promise<RescanResult> {
  console.log("Starting credit rescan for blocked issues");

  try {
    // Fetch GitHub App credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

    const appConfig: GitHubAppConfig = { appId, privateKey };

    // Scan all repositories for blocked issues and retry if credits are now available
    const result = await scanRepositoriesForBlockedIssues(appConfig);

    console.log(`Credit rescan complete:`, JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error(`Credit rescan failed: ${error}`);
    throw error;
  }
}
