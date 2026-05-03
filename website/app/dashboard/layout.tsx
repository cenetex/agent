'use client'

import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { SignOutButton } from '@/components/sign-out-button'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { data: session } = useSession()

  return (
    <div className="flex min-h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow">
        <div className="p-6 border-b">
          <h2 className="text-lg font-bold">Dashboard</h2>
          {session?.user && (
            <p className="text-sm text-gray-600 mt-2">
              {session.user.email}
            </p>
          )}
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
        </nav>

        <div className="absolute bottom-6 left-6 right-6">
          <SignOutButton />
        </div>
      </aside>

      <main className="flex-1">
        {children}
      </main>
    </div>
  )
}
