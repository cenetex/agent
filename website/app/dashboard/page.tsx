import { getServerSession } from "next-auth"
import { authOptions } from "@/app/auth"
import { redirect } from "next/navigation"
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"

interface CreditBalance {
  current_balance: number
  total_purchased: number
  total_spent: number
}

async function getInstallationRepositories(
  accessToken: string
): Promise<Array<{ full_name: string }>> {
  const response = await fetch("https://api.github.com/user/installations", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!response.ok) {
    console.error("Failed to fetch installations:", response.status)
    return []
  }

  const installations = await response.json() as any
  const appSlug = process.env.GITHUB_APP_SLUG || "cenetex-coding-agent"
  const appInstallation = installations.installations?.find(
    (inst: any) => inst.app_slug === appSlug
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
    console.error("Failed to fetch repositories:", repositoriesResponse.status)
    return []
  }

  const data = await repositoriesResponse.json() as any
  return data.repositories || []
}

async function getCreditBalance(
  repoSlug: string
): Promise<CreditBalance | null> {
  const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" })
  const bucket = process.env.CREDITS_BUCKET

  if (!bucket) {
    return null
  }

  try {
    const key = `credits/${repoSlug}/balance.json`
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })

    const response = await s3.send(command)
    const body = await response.Body?.transformToString()
    return body ? JSON.parse(body) : null
  } catch (error) {
    return null
  }
}

export default async function DashboardOverview() {
  const session = await getServerSession(authOptions)

  if (!session) {
    redirect("/signin")
  }

  let repositories: Array<{ name: string; balance: CreditBalance | null }> = []
  let error: string | null = null

  try {
    const accessToken = (session as any).accessToken
    if (accessToken) {
      const repos = await getInstallationRepositories(accessToken)
      const balancesPromises = repos.map(async (repo) => ({
        name: repo.full_name,
        balance: await getCreditBalance(repo.full_name),
      }))
      repositories = await Promise.all(balancesPromises)
    }
  } catch (err) {
    console.error("Error fetching balances:", err)
    error = "Failed to load credit data"
  }

  const totalBalance = repositories.reduce(
    (sum, r) => sum + (r.balance?.current_balance || 0),
    0
  )
  const totalSpent = repositories.reduce(
    (sum, r) => sum + (r.balance?.total_spent || 0),
    0
  )
  const totalPurchased = repositories.reduce(
    (sum, r) => sum + (r.balance?.total_purchased || 0),
    0
  )

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Current Balance</h2>
          <p className="text-4xl font-bold text-blue-600">{totalBalance}</p>
          <p className="text-gray-500 text-sm mt-1">credits available</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Spent</h2>
          <p className="text-4xl font-bold text-orange-600">{totalSpent}</p>
          <p className="text-gray-500 text-sm mt-1">credits used</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Purchased</h2>
          <p className="text-4xl font-bold text-green-600">{totalPurchased}</p>
          <p className="text-gray-500 text-sm mt-1">credits purchased</p>
        </div>
      </div>

      {error && (
        <div className="mt-8 bg-red-50 border border-red-200 rounded-lg p-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {repositories.length > 0 && (
        <div className="mt-8">
          <h2 className="text-2xl font-bold mb-4">Repository Credits</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {repositories.map((repo) => (
              <div key={repo.name} className="bg-white rounded-lg shadow p-6">
                <h3 className="font-semibold text-lg text-gray-900 mb-3">{repo.name}</h3>
                {repo.balance ? (
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Current Balance:</span>
                      <span className="font-medium">{repo.balance.current_balance}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Total Spent:</span>
                      <span className="font-medium">{repo.balance.total_spent}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Total Purchased:</span>
                      <span className="font-medium">{repo.balance.total_purchased}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-gray-500 text-sm">No credit data available</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
