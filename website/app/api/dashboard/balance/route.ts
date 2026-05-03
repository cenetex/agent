import { auth } from "@/auth";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

interface CreditBalance {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
}

interface RepoBalance extends CreditBalance {}

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
});

const BUCKET = process.env.ARTIFACTS_BUCKET || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";

async function getUserInstallations(
  accessToken: string
): Promise<Array<{ owner: string; repo: string }>> {
  try {
    const res = await fetch("https://api.github.com/user/installations", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "agent-dashboard",
      },
    });

    if (!res.ok) {
      const error = await res.text();
      console.error(`GitHub API error: ${res.status} ${error}`);
      throw new Error(`Failed to fetch installations: ${res.status}`);
    }

    const data = (await res.json()) as any;
    const installations = data.installations || [];

    // Filter for cenetex-coding-agent app
    const agentInstalls = installations.filter(
      (inst: any) =>
        inst.app_slug === "cenetex-coding-agent" ||
        inst.app_id.toString() === GITHUB_APP_ID
    );

    // Extract repos from each installation
    const repos: Array<{ owner: string; repo: string }> = [];
    for (const install of agentInstalls) {
      const reposRes = await fetch(
        `https://api.github.com/user/installations/${install.id}/repositories`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "agent-dashboard",
          },
        }
      );

      if (reposRes.ok) {
        const reposData = (await reposRes.json()) as any;
        const instRepos = reposData.repositories || [];
        for (const repo of instRepos) {
          repos.push({
            owner: repo.owner.login,
            repo: repo.name,
          });
        }
      }
    }

    return repos;
  } catch (error) {
    console.error("Error fetching user installations:", error);
    throw error;
  }
}

async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const key = `credits/${repoSlug}/balance.json`;
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    const balance = JSON.parse(content) as CreditBalance;
    return balance;
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      return null;
    }
    console.error(`Error reading S3 balance for ${repoSlug}:`, error);
    throw new Error(`S3 read failed for ${repoSlug}`);
  }
}

export async function GET() {
  try {
    // Check authentication
    const session = await auth();

    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!session.user.accessToken) {
      return NextResponse.json(
        { error: "No GitHub token in session" },
        { status: 401 }
      );
    }

    if (!BUCKET) {
      console.error("ARTIFACTS_BUCKET not configured");
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      );
    }

    // Fetch user's installations and repos
    const repos = await getUserInstallations(session.user.accessToken);

    if (repos.length === 0) {
      return NextResponse.json([]);
    }

    // Fetch credit balance for each repo
    const balances: RepoBalance[] = [];
    const errors: string[] = [];

    for (const repo of repos) {
      const repoSlug = `${repo.owner}/${repo.repo}`;
      try {
        const balance = await getCreditBalance(repoSlug);
        if (balance) {
          balances.push(balance);
        } else {
          balances.push({
            repo_slug: repoSlug,
            current_balance: 0,
            total_purchased: 0,
            total_spent: 0,
            last_updated: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error(`Failed to fetch balance for ${repoSlug}:`, error);
        errors.push(repoSlug);
      }
    }

    // If some repos failed, return 502 with logged error
    if (errors.length > 0) {
      console.error(`S3 read failed for repos: ${errors.join(", ")}`);
      return NextResponse.json(
        {
          error: "Failed to fetch some repository balances",
          failed_repos: errors,
        },
        { status: 502 }
      );
    }

    return NextResponse.json(balances);
  } catch (error) {
    console.error("Balance endpoint error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
