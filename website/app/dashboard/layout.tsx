import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/auth'
import { SignOutButton } from '@/components/sign-out-button'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getServerSession(authOptions)

  if (!session) {
    redirect('/signin')
  }

  return (
    <div className="flex min-h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow">
        <div className="p-6 flex justify-between items-start">
          <div>
            <h2 className="text-lg font-bold">Dashboard</h2>
            <p className="text-sm text-gray-600 mt-1">{session.user?.name}</p>
          </div>
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

        <div className="mt-6 px-3 border-t pt-6">
          <SignOutButton />
        </div>
      </aside>

      <main className="flex-1">
        {children}
      </main>
    </div>
  )
}
