'use client'

import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import Link from 'next/link'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/signin')
    }
  }, [status, router])

  if (status === 'loading') {
    return <div className="p-8">Loading...</div>
  }

  if (!session) {
    return null
  }

  return (
    <div className="flex min-h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow">
        <div className="p-6">
          <h2 className="text-lg font-bold">Dashboard</h2>
          <p className="text-sm text-gray-600 mt-1">{session.user?.email}</p>
        </div>

        <nav className="mt-6 space-y-2 px-3">
          <Link
            href="/dashboard"
            className="block px-4 py-2 text-gray-700 hover:bg-blue-50 rounded"
          >
            Overview
          </Link>
          <Link
            href="/dashboard/tasks"
            className="block px-4 py-2 text-gray-700 hover:bg-blue-50 rounded"
          >
            Task History
          </Link>
          <Link
            href="/dashboard/spending"
            className="block px-4 py-2 text-gray-700 hover:bg-blue-50 rounded"
          >
            Spending
          </Link>
          <Link
            href="/dashboard/credits"
            className="block px-4 py-2 text-gray-700 hover:bg-blue-50 rounded"
          >
            Credits
          </Link>
          <Link
            href="/dashboard/settings"
            className="block px-4 py-2 text-gray-700 hover:bg-blue-50 rounded"
          >
            Settings
          </Link>
        </nav>
      </aside>

      <main className="flex-1">
        {children}
      </main>
    </div>
  )
}
