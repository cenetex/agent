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
  createGitHubAppJWT,
  getInstallationId,
  createInstallationToken,
  parseRepoSlug,
  type TaskMetadata,
} from "./types";

const s3 = new S3Client({});
const ssm = new SSMClient({});

const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const MIN_MERGED_PRS_FOR_RELEASE = parseInt(process.env.MIN_MERGED_PRS_FOR_RELEASE || "5", 10);

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
      "User-Agent": "github-agent-release-draft",
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

async function getMergedPRsSinceTag(
  repoOwner: string,
  repoName: string,
  token: string,
  sinceTag: string | null
): Promise<Array<{ title: string; number: number; sha: string }>> {
  try {
    let query = `/repos/${repoOwner}/${repoName}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;

    let mergedPRs: Array<{ title: string; number: number; sha: string }> = [];

    const response = await githubRequest(query, token, { method: "GET" }, [200]);
    const prs = await response.json() as any[];

    // Filter merged PRs
    const allMerged = prs.filter((pr: any) => pr.merged_at);

    if (!sinceTag) {
      // If no previous tag, just return all merged PRs
      mergedPRs = allMerged.map((pr: any) => ({
        title: pr.title,
        number: pr.number,
        sha: pr.merge_commit_sha,
      }));
    } else {
      // Get commit date of the tag
      const tagResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}/git/refs/tags/${sinceTag}`,
        token,
        { method: "GET" },
        [200, 404]
      );

      if (tagResponse.status === 200) {
        const tagRef = await tagResponse.json() as any;
        const commitResponse = await githubRequest(
          `/repos/${repoOwner}/${repoName}/git/commits/${tagRef.object.sha}`,
          token,
          { method: "GET" },
          [200]
        );

        const tagCommit = await commitResponse.json() as any;
        const tagDate = new Date(tagCommit.committer.date).getTime();

        // Filter PRs merged after tag date
        mergedPRs = allMerged
          .filter((pr: any) => new Date(pr.merged_at).getTime() > tagDate)
          .map((pr: any) => ({
            title: pr.title,
            number: pr.number,
            sha: pr.merge_commit_sha,
          }));
      } else {
        mergedPRs = allMerged.map((pr: any) => ({
          title: pr.title,
          number: pr.number,
          sha: pr.merge_commit_sha,
        }));
      }
    }

    console.log(`Found ${mergedPRs.length} merged PRs since tag ${sinceTag || "beginning"}`);
    return mergedPRs;
  } catch (error) {
    console.error(`Failed to fetch merged PRs for ${repoOwner}/${repoName}:`, error);
    return [];
  }
}

function bumpVersion(currentVersion: string): string {
  const parts = currentVersion.replace(/^v/, "").split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || "0", 10);
  const patch = parseInt(parts[2] || "0", 10);

  // Bump patch version
  return `v${major}.${minor}.${patch + 1}`;
}

async function getDraftReleaseByTag(
  repoOwner: string,
  repoName: string,
  token: string,
  tagName: string
): Promise<{ id: number; html_url: string } | null> {
  try {
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/releases`,
      token,
      { method: "GET" },
      [200]
    );

    const releases = await response.json() as any[];
    const draftRelease = releases.find(
      (release: any) => release.draft && release.tag_name === tagName
    );

    if (draftRelease) {
      return { id: draftRelease.id, html_url: draftRelease.html_url };
    }

    return null;
  } catch (error) {
    console.error(
      `Failed to fetch releases for ${repoOwner}/${repoName}:`,
      error
    );
    return null;
  }
}

async function createDraftRelease(
  repoOwner: string,
  repoName: string,
  token: string,
  nextVersion: string,
  mergedPRs: Array<{ title: string; number: number; sha: string }>
): Promise<string> {
  try {
    // Build release notes from merged PRs
    const releaseNotes = `## Changes\n\n${mergedPRs
      .map((pr) => `- ${pr.title} (#${pr.number})`)
      .join("\n")}\n\n## Commits\n\n${mergedPRs
      .map((pr) => `- ${pr.sha.substring(0, 7)}`)
      .join("\n")}`;

    // Check if a draft release with this tag already exists
    const existingDraft = await getDraftReleaseByTag(
      repoOwner,
      repoName,
      token,
      nextVersion
    );

    if (existingDraft) {
      console.log(
        `Draft release ${nextVersion} already exists, updating it instead`
      );

      // Update the existing draft release
      const response = await githubRequest(
        `/repos/${repoOwner}/${repoName}/releases/${existingDraft.id}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({
            body: releaseNotes,
            draft: true,
            prerelease: false,
          }),
        },
        [200]
      );

      const release = await response.json() as any;
      console.log(`Updated draft release ${nextVersion} with ${mergedPRs.length} PRs`);
      return release.html_url;
    }

    // Create new draft release if one doesn't exist
    const response = await githubRequest(
      `/repos/${repoOwner}/${repoName}/releases`,
      token,
      {
        method: "POST",
        body: JSON.stringify({
          tag_name: nextVersion,
          name: `Release ${nextVersion}`,
          body: releaseNotes,
          draft: true,
          prerelease: false,
        }),
      },
      [201]
    );

    const release = await response.json() as any;
    console.log(`Created draft release ${nextVersion} with ${mergedPRs.length} PRs`);
    return release.html_url;
  } catch (error) {
    console.error(`Failed to create draft release for ${repoOwner}/${repoName}:`, error);
    throw error;
  }
}

interface DigestIssueData {
  repoOwner: string;
  repoName: string;
  draftReleaseUrl: string;
  draftReleaseVersion: string;
  prCount: number;
}

async function addDraftReleaseCommentToDigest(
  token: string,
  digestData: DigestIssueData
): Promise<void> {
  try {
    // Find today's digest issue in cenetex/agent repo
    const response = await githubRequest(
      `/repos/cenetex/agent/issues?state=open&labels=bot-summary&sort=updated&direction=desc&per_page=10`,
      token,
      { method: "GET" },
      [200]
    );

    const issues = await response.json() as any[];
    const todayString = new Date().toISOString().split("T")[0];
    const digestIssue = issues.find((issue: any) => issue.title.includes(todayString));

    if (!digestIssue) {
      console.log("No digest issue found for today, skipping comment");
      return;
    }

    const comment = `📦 **Draft Release Ready**

A new draft release has been created:

- **Repo**: ${digestData.repoOwner}/${digestData.repoName}
- **Version**: ${digestData.draftReleaseVersion}
- **PRs**: ${digestData.prCount} merged since last release
- **Link**: [Review and publish](${digestData.draftReleaseUrl})

Click the link to review the draft release in GitHub, then click "Publish" to ship it.`;

    await githubRequest(
      `/repos/cenetex/agent/issues/${digestIssue.number}/comments`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ body: comment }),
      },
      [201]
    );

    console.log(`Added draft release comment to digest issue #${digestIssue.number}`);
  } catch (error) {
    console.error("Failed to add draft release comment to digest:", error);
    // Don't fail the entire function if comment posting fails
  }
}

export async function handler(): Promise<void> {
  console.log("Starting release draft check");

  try {
    // Fetch GitHub credentials
    const [appId, privateKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    ]);

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

    console.log(`Checking ${reposList.size} repositories for draft release creation`);

    // For each repo, check if we should create a draft release
    for (const repoSlug of reposList) {
      try {
        const { owner, name } = parseRepoSlug(repoSlug);

        // Get installation token for this repo
        const jwt = createGitHubAppJWT(appId, privateKey);
        const installationId = await getInstallationId(owner, name, jwt);
        const tokenResult = await createInstallationToken(installationId, jwt);
        const githubToken = tokenResult.token;

        // Get latest tag
        const latestTag = await getLatestTag(owner, name, githubToken);
        console.log(`Latest tag for ${repoSlug}: ${latestTag || "none"}`);

        // Get merged PRs since latest tag
        const mergedPRs = await getMergedPRsSinceTag(owner, name, githubToken, latestTag);

        // Check if we have enough PRs for a release
        if (mergedPRs.length >= MIN_MERGED_PRS_FOR_RELEASE) {
          console.log(`${repoSlug}: ${mergedPRs.length} PRs >= ${MIN_MERGED_PRS_FOR_RELEASE}, creating draft release`);

          // Calculate next version
          const nextVersion = latestTag ? bumpVersion(latestTag) : "v0.0.1";

          // Create draft release
          const releaseUrl = await createDraftRelease(
            owner,
            name,
            githubToken,
            nextVersion,
            mergedPRs
          );

          // Add comment to daily digest
          const jwtForDigest = createGitHubAppJWT(appId, privateKey);
          const digestInstallationId = await getInstallationId("cenetex", "agent", jwtForDigest);
          const digestTokenResult = await createInstallationToken(digestInstallationId, jwtForDigest);

          await addDraftReleaseCommentToDigest(
            digestTokenResult.token,
            {
              repoOwner: owner,
              repoName: name,
              draftReleaseUrl: releaseUrl,
              draftReleaseVersion: nextVersion,
              prCount: mergedPRs.length,
            }
          );
        } else {
          console.log(`${repoSlug}: ${mergedPRs.length} PRs < ${MIN_MERGED_PRS_FOR_RELEASE}, skipping draft release`);
        }
      } catch (error) {
        console.error(`Failed to check ${repoSlug} for draft release:`, error);
        // Continue to next repo
      }
    }

    console.log("Release draft check completed");
  } catch (error) {
    console.error(`Release draft handler failed: ${error}`);
    throw error;
  }
}
