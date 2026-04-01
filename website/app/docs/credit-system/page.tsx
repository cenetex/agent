export const metadata = {
  title: 'Credit System - Agent',
}

export default function CreditSystem() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Credit System</h1>

        <div className="prose prose-lg max-w-none">
          <h2>How Credits Work</h2>
          <p>
            Agent uses a credit-based billing system. Each task deducts credits based on the AI model used
            to complete it. Think of credits like prepaid tokens that fund your agent tasks.
          </p>

          <h2>Model Pricing</h2>
          <p>Different AI models have different costs:</p>

          <table className="w-full border-collapse border border-gray-300 my-6">
            <thead>
              <tr className="bg-gray-100">
                <th className="border border-gray-300 p-3 text-left">Model</th>
                <th className="border border-gray-300 p-3 text-left">Credits</th>
                <th className="border border-gray-300 p-3 text-left">USD Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-300 p-3">claude-haiku-4-5</td>
                <td className="border border-gray-300 p-3">4</td>
                <td className="border border-gray-300 p-3">$0.40</td>
              </tr>
              <tr className="bg-gray-50">
                <td className="border border-gray-300 p-3">claude-sonnet-4-6</td>
                <td className="border border-gray-300 p-3">12</td>
                <td className="border border-gray-300 p-3">$1.20</td>
              </tr>
              <tr>
                <td className="border border-gray-300 p-3">claude-opus-4-6</td>
                <td className="border border-gray-300 p-3">20</td>
                <td className="border border-gray-300 p-3">$2.00</td>
              </tr>
            </tbody>
          </table>

          <h2>Initial Credits</h2>
          <p>
            New repositories receive <strong>100 free credits</strong> to get started. This is enough for:
          </p>
          <ul>
            <li>~25 tasks using Haiku (budget-friendly)</li>
            <li>~8 tasks using Sonnet (balanced)</li>
            <li>~5 tasks using Opus (advanced)</li>
          </ul>

          <h2>Tracking Your Credits</h2>
          <p>
            Log in to the dashboard to see your credit balance and spending history. You can:
          </p>
          <ul>
            <li>View current balance per repository</li>
            <li>See transaction history and task costs</li>
            <li>Monitor spend rate and projections</li>
            <li>Purchase additional credits (coming soon)</li>
          </ul>

          <h2>Configure Model Per Repository</h2>
          <p>
            Control which model the agent uses by creating an <code>AGENT.md</code> file in your repository:
          </p>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md
model: anthropic/claude-opus-4-6
model-for-issues: anthropic/claude-sonnet-4-6
model-for-reviews: anthropic/claude-haiku-4-5`}
          </pre>

          <h2>Failed Tasks</h2>
          <p>
            Tasks that fail or time out are <strong>not charged</strong>. A refund is issued automatically
            if the agent encounters an error and cannot complete the task.
          </p>

          <h2>Low Balance Notifications</h2>
          <p>
            The daily digest includes a warning when your repository falls below 10 credits. Subscribe to
            notifications to stay informed about your spending.
          </p>
        </div>

        <div className="mt-12 bg-yellow-50 border border-yellow-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Payment Coming Soon</h3>
          <p className="text-gray-700">
            Right now you can use the free tier. Soon you'll be able to purchase additional credits directly
            from the dashboard. Keep an eye on your balance!
          </p>
        </div>
      </div>
    </div>
  )
}
