export default function DashboardOverview() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Current Balance</h2>
          <p className="text-4xl font-bold text-blue-600">75</p>
          <p className="text-gray-500 text-sm mt-1">credits available</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Spent</h2>
          <p className="text-4xl font-bold text-orange-600">25</p>
          <p className="text-gray-500 text-sm mt-1">credits used</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Purchased</h2>
          <p className="text-4xl font-bold text-green-600">100</p>
          <p className="text-gray-500 text-sm mt-1">credits purchased</p>
        </div>
      </div>

      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Coming Soon</h2>
        <p className="text-gray-700">
          The dashboard will show real-time data once GitHub OAuth is configured:
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
