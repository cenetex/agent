import Link from 'next/link'

export function PricingSection() {
  return (
    <div className="py-20 bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-bold mb-4">Simple, Transparent Pricing</h2>
          <p className="text-xl text-gray-600">
            Pay only for what you use. Start free with 100 credits.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          {/* Free Tier */}
          <div className="bg-white rounded-lg shadow-md p-8">
            <h3 className="text-2xl font-bold mb-4">Free Tier</h3>
            <p className="text-5xl font-bold text-blue-600 mb-2">$0</p>
            <p className="text-gray-600 mb-8">perfect for getting started</p>
            <ul className="space-y-3 mb-8">
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                100 credits
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                ~25 tasks with Haiku
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Community support
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Full feature access
              </li>
            </ul>
            <a
              href="https://github.com/apps/cenetex-coding-agent/installations/new"
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition block text-center"
            >
              Install Now
            </a>
          </div>

          {/* Pro Tier */}
          <div className="bg-white rounded-lg shadow-lg p-8 border-2 border-blue-600 relative">
            <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 bg-blue-600 text-white px-4 py-1 rounded-full text-sm font-semibold">
              POPULAR
            </div>
            <h3 className="text-2xl font-bold mb-4">Pro</h3>
            <p className="text-5xl font-bold text-blue-600 mb-2">$50</p>
            <p className="text-gray-600 mb-8">for regular use</p>
            <ul className="space-y-3 mb-8">
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                500 credits/month
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                All models (Haiku, Sonnet, Opus)
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Auto-review enabled
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Priority support (coming soon)
              </li>
            </ul>
            <button
              disabled
              className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
            >
              Coming Soon
            </button>
          </div>

          {/* Enterprise Tier */}
          <div className="bg-white rounded-lg shadow-md p-8">
            <h3 className="text-2xl font-bold mb-4">Enterprise</h3>
            <p className="text-5xl font-bold text-blue-600 mb-2">Custom</p>
            <p className="text-gray-600 mb-8">for teams and orgs</p>
            <ul className="space-y-3 mb-8">
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Unlimited credits
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Self-hosted option
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Custom model selection
              </li>
              <li className="flex items-center">
                <span className="text-green-500 mr-3">✓</span>
                Dedicated support
              </li>
            </ul>
            <a
              href="mailto:sales@cenetex.com"
              className="w-full bg-gray-300 text-gray-900 py-2 rounded hover:bg-gray-400 transition block text-center"
            >
              Contact Sales
            </a>
          </div>
        </div>

        {/* Credit Costs Table */}
        <div className="bg-white rounded-lg shadow-md p-8">
          <h3 className="text-2xl font-bold mb-6">Model Costs</h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-gray-200">
                  <th className="text-left py-3">Model</th>
                  <th className="text-right py-3">Credits / Task</th>
                  <th className="text-right py-3">USD Value</th>
                  <th className="text-left py-3">Best For</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="py-3">claude-haiku-4-5</td>
                  <td className="text-right">4</td>
                  <td className="text-right">$0.40</td>
                  <td>Simple fixes, reviews</td>
                </tr>
                <tr className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="py-3">claude-sonnet-4-6</td>
                  <td className="text-right">12</td>
                  <td className="text-right">$1.20</td>
                  <td>Most tasks (recommended)</td>
                </tr>
                <tr className="hover:bg-gray-50">
                  <td className="py-3">claude-opus-4-6</td>
                  <td className="text-right">20</td>
                  <td className="text-right">$2.00</td>
                  <td>Complex features</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* FAQ */}
        <div className="mt-16 max-w-3xl mx-auto">
          <h3 className="text-2xl font-bold mb-8">Frequently Asked Questions</h3>
          <div className="space-y-6">
            <div>
              <h4 className="font-bold text-lg mb-2">Can I get more free credits?</h4>
              <p className="text-gray-600">
                You get 100 free credits when you first install the app. After that, you can purchase
                additional credits from the dashboard or upgrade to a paid plan.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-lg mb-2">Do I lose credits if a task fails?</h4>
              <p className="text-gray-600">
                No! Failed tasks are not charged. If the agent encounters an error, you receive a full refund.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-lg mb-2">Can I use my own AI model?</h4>
              <p className="text-gray-600">
                The hosted Agent service uses Claude models. For complete customization, you can
                <a href="https://github.com/cenetex/agent" className="text-blue-600 hover:text-blue-700"> self-host</a> the agent with your own models.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
