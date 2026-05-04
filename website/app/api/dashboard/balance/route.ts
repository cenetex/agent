import { getServerSession } from "next-auth"
import { authOptions } from "@/app/auth"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"

interface CreditBalance {
  repo_slug: string
  current_balance: number
  total_purchased: number
  total_spent: number
  last_updated: string
  version: number
}

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
const CREDITS_BUCKET = process.env.CREDITS_BUCKET
const GITHUB_APP_SLUG = process.env.GITHUB_APP_SLUG || "cenetex-coding-agent"

async function getInstallationRepositories(
  accessToken: string
): Promise<Array<{ full_name: string }>> {
  const response = await fetch(
    "https://api.github.com/user/installations",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (!response.ok) {
    throw new Error(
      `Failed to fetch installations: ${response.status} ${await response.text()}`
    )
  }

  const installations = await response.json() as any
  const appInstallation = installations.installations?.find(
    (inst: any) => inst.app_slug === GITHUB_APP_SLUG
  )

  if (!appInstallation) {
    return []
  }

  const repositoriesResponse = await fetch(
    `https://api.github.com/user/installations/${appInstallation.id}/repositories`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  )

  if (!repositoriesResponse.ok) {
    throw new Error(
      `Failed to fetch repositories: ${repositoriesResponse.status} ${await repositoriesResponse.text()}`
    )
  }

  const data = await repositoriesResponse.json() as any
  return data.repositories || []
}

async function getCreditBalance(repoSlug: string): Promise<CreditBalance | null> {
  try {
    const key = `credits/${repoSlug}/balance.json`
    const command = new GetObjectCommand({
      Bucket: CREDITS_BUCKET,
      Key: key,
    })

    const response = await s3.send(command)
    const body = await response.Body?.transformToString()
    return body ? JSON.parse(body) : null
  } catch ((error: any) => {
    if (error.name === "NoSuchKey") {
      return null
    }
    throw error
  })
}

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions)

    if (!session || !session.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    if (!CREDITS_BUCKET) {
      return new Response(
        JSON.stringify({ error: "CREDITS_BUCKET not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const accessToken = (session as any).accessToken
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "No GitHub access token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const repositories = await getInstallationRepositories(accessToken)
    const balancesPromises = repositories.map((repo) =>
      getCreditBalance(repo.full_name).then((balance) => ({
        repo: repo.full_name,
        balance,
      }))
    )

    const balances = await Promise.all(balancesPromises)

    return new Response(JSON.stringify({ repositories: balances }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    console.error("Balance API error:", error)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}
