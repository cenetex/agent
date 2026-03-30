export const metadata = {
  title: 'Task History - Dashboard',
}

export default function TaskHistory() {
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Task History</h1>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Issue</th>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Model</th>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Cost</th>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
              <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">PR</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr className="hover:bg-gray-50">
              <td className="px-6 py-3 text-sm text-gray-900">#123: Fix login bug</td>
              <td className="px-6 py-3"><span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs">Succeeded</span></td>
              <td className="px-6 py-3 text-sm text-gray-600">sonnet-4-6</td>
              <td className="px-6 py-3 text-sm text-gray-600">12 credits</td>
              <td className="px-6 py-3 text-sm text-gray-600">2 days ago</td>
              <td className="px-6 py-3"><a href="#" className="text-blue-600 hover:text-blue-700">#456</a></td>
            </tr>
            <tr className="hover:bg-gray-50">
              <td className="px-6 py-3 text-sm text-gray-900">#124: Add dark mode</td>
              <td className="px-6 py-3"><span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs">Succeeded</span></td>
              <td className="px-6 py-3 text-sm text-gray-600">opus-4-6</td>
              <td className="px-6 py-3 text-sm text-gray-600">20 credits</td>
              <td className="px-6 py-3 text-sm text-gray-600">1 week ago</td>
              <td className="px-6 py-3"><a href="#" className="text-blue-600 hover:text-blue-700">#457</a></td>
            </tr>
            <tr className="hover:bg-gray-50">
              <td className="px-6 py-3 text-sm text-gray-900">#125: Review PR</td>
              <td className="px-6 py-3"><span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded text-xs">Waiting</span></td>
              <td className="px-6 py-3 text-sm text-gray-600">haiku-4-5</td>
              <td className="px-6 py-3 text-sm text-gray-600">4 credits</td>
              <td className="px-6 py-3 text-sm text-gray-600">3 days ago</td>
              <td className="px-6 py-3 text-gray-400">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Task History Stub</h2>
        <p className="text-gray-700">
          This is a stub view showing the structure. In production, this will fetch
          real task data from S3 and display your complete task history with full details.
        </p>
      </div>
    </div>
  )
}
