import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

export interface BalanceResponse {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
}

interface CreditBalance {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
  version: number;
}

interface Installation {
  id: number;
  account: {
    login: string;
  };
  repository_selection: string;
  repositories?: Array<{
    name: string;
    full_name: string;
  }>;
}

const s3 = new S3Client({});
const BUCKET = process.env.ARTIFACTS_BUCKET || "github-agent-artifacts-022118847419-us-east-1";

async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `credits/${repoSlug}/balance.json`,
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

async function getUserInstallations(userToken: string): Promise<Installation[]> {
  const response = await fetch("https://api.github.com/user/installations", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${userToken}`,
      "User-Agent": "github-agent-dashboard",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed with status ${response.status}`);
  }

  const data = (await response.json()) as any;
  return data.installations || [];
}

async function getInstallationRepositories(
  installationId: number,
  userToken: string
): Promise<Array<{ owner: string; name: string }>> {
  const response = await fetch(`https://api.github.com/user/installations/${installationId}/repositories`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${userToken}`,
      "User-Agent": "github-agent-dashboard",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API failed with status ${response.status}`);
  }

  const data = (await response.json()) as any;
  return (data.repositories || []).map((repo: any) => ({
    owner: repo.owner.login,
    name: repo.name,
  }));
}

export async function GET(request: Request) {
  try {
    // Get auth session - this will be implemented in the NextAuth setup (issue #(TBD-1))
    // For now, we check for a Bearer token in the Authorization header as a placeholder
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userToken = authHeader.slice(7);

    // Get user's installations of the cenetex-coding-agent app
    const installations = await getUserInstallations(userToken);

    // Filter for cenetex-coding-agent app installations
    const agentInstallations = installations.filter(
      (inst: any) => inst.app_slug === "cenetex-coding-agent"
    );

    if (agentInstallations.length === 0) {
      return Response.json([] as BalanceResponse[]);
    }

    // Fetch repositories and their balances in parallel
    const repos: Array<{ owner: string; repo: string }> = [];

    for (const installation of agentInstallations) {
      const repositories = await getInstallationRepositories(installation.id, userToken);
      for (const repo of repositories) {
        repos.push({ owner: repo.owner, repo: repo.name });
      }
    }

    // Fetch all balances in parallel
    const balances = await Promise.all(
      repos.map(async ({ owner, repo }) => {
        const repoSlug = `${owner}/${repo}`;
        try {
          const balance = await getCreditBalance(repoSlug);
          if (balance) {
            return {
              repo_slug: balance.repo_slug,
              current_balance: balance.current_balance,
              total_purchased: balance.total_purchased,
              total_spent: balance.total_spent,
              last_updated: balance.last_updated,
            } as BalanceResponse;
          }
          return null;
        } catch (error) {
          console.error(`Failed to read balance for ${repoSlug}:`, error);
          return null;
        }
      })
    );

    // Filter out nulls (repos with no balance file)
    const results = balances.filter((b): b is BalanceResponse => b !== null);

    return Response.json(results);
  } catch (error) {
    console.error("Failed to fetch balance data:", error);
    return Response.json(
      { error: "Failed to fetch balance data" },
      { status: 502 }
    );
  }
}
