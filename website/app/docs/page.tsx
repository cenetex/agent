import Link from 'next/link'
import { FiBook, FiClock, FiDollarSign, FiSettings, FiHelpCircle, FiCode } from 'react-icons/fi'

export const metadata = {
  title: 'Documentation - Agent',
}

const docCategories = [
  {
    title: 'Getting Started',
    icon: FiBook,
    description: 'Install the GitHub app, label an issue, and get your first PR',
    href: '/docs/getting-started',
  },
  {
    title: 'Credit System',
    icon: FiDollarSign,
    description: 'Understand how credits work, pricing models, and costs',
    href: '/docs/credit-system',
  },
  {
    title: 'Task Lifecycle',
    icon: FiClock,
    description: 'Learn about task states, labels, and retry behavior',
    href: '/docs/task-lifecycle',
  },
  {
    title: 'Configuring Agent',
    icon: FiSettings,
    description: 'Write AGENT.md and CLAUDE.md for repo-specific behavior',
    href: '/docs/configuring-agent',
  },
  {
    title: 'Review Process',
    icon: FiCode,
    description: 'How the agent reviews code and when human review is required',
    href: '/docs/review-process',
  },
  {
    title: 'Troubleshooting',
    icon: FiHelpCircle,
    description: 'Common issues, logging, and how to debug failures',
    href: '/docs/troubleshooting',
  },
]

export default function DocsHub() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">Documentation</h1>
          <p className="text-lg text-gray-600">
            Learn how to use and configure the Agent GitHub app
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {docCategories.map((category) => {
            const Icon = category.icon
            return (
              <Link
                key={category.href}
                href={category.href}
                className="bg-white rounded-lg shadow hover:shadow-lg transition p-6 block"
              >
                <div className="flex items-start mb-4">
                  <Icon className="w-8 h-8 text-blue-600 flex-shrink-0 mr-3" />
                  <h2 className="text-xl font-semibold text-gray-900">{category.title}</h2>
                </div>
                <p className="text-gray-600">{category.description}</p>
              </Link>
            )
          })}
        </div>

        <div className="mt-12 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Open Source</h3>
          <p className="text-gray-700">
            Agent is open source and embraces the "run your own" model. You can self-host the agent,
            or use our managed service at agent.cenetex.com. Check out the{' '}
            <a href="https://github.com/cenetex/agent" className="text-blue-600 hover:text-blue-700">
              GitHub repository
            </a>{' '}
            for more details.
          </p>
        </div>
      </div>
    </div>
  )
}
