import Link from 'next/link'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen bg-gray-100">
      <aside className="w-64 bg-white shadow">
        <div className="p-6">
          <h2 className="text-lg font-bold">Dashboard</h2>
          <p className="text-sm text-gray-600 mt-1">Coming soon</p>
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
      </aside>

      <main className="flex-1">
        {children}
      </main>
    </div>
  )
}
