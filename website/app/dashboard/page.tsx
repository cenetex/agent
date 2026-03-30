'use client'

import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'

interface CreditBalance {
  repo_slug: string
  current_balance: number
  total_purchased: number
  total_spent: number
  last_updated: string
}

export default function DashboardOverview() {
  const { data: session } = useSession()
  const [balance, setBalance] = useState<CreditBalance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // In a real app, discover repositories for the user via GitHub API
    // For now, this is a stub showing the structure
    setBalance({
      repo_slug: 'owner/example-repo',
      current_balance: 75,
      total_purchased: 100,
      total_spent: 25,
      last_updated: new Date().toISOString(),
    })
    setLoading(false)
  }, [])

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : balance ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-gray-600 text-sm font-semibold mb-2">Current Balance</h2>
            <p className="text-4xl font-bold text-blue-600">{balance.current_balance}</p>
            <p className="text-gray-500 text-sm mt-1">credits available</p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Spent</h2>
            <p className="text-4xl font-bold text-orange-600">{balance.total_spent}</p>
            <p className="text-gray-500 text-sm mt-1">credits used</p>
          </div>

          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Purchased</h2>
            <p className="text-4xl font-bold text-green-600">{balance.total_purchased}</p>
            <p className="text-gray-500 text-sm mt-1">credits purchased</p>
          </div>
        </div>
      ) : null}

      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Dashboard Stub</h2>
        <p className="text-gray-700">
          This is a stub implementation of the dashboard. In production, this will:
        </p>
        <ul className="list-disc list-inside text-gray-700 mt-3 space-y-1">
          <li>Fetch all your repositories from GitHub</li>
          <li>Show credit balance for each repository</li>
          <li>Display transaction history and spending trends</li>
          <li>Allow purchasing additional credits</li>
          <li>Provide detailed task history with costs</li>
        </ul>
      </div>
    </div>
  )
}
