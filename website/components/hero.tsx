import Link from 'next/link'

export function HeroSection() {
  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-100 py-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-5xl md:text-6xl font-bold text-gray-900 mb-6">
            Autonomous Coding Agent
          </h1>
          <p className="text-xl md:text-2xl text-gray-700 mb-8 max-w-3xl mx-auto">
            Automatically fix bugs, implement features, and review code on GitHub.
            Powered by Claude AI.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="https://github.com/apps/cenetex-coding-agent/installations/new"
              className="bg-blue-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              Install on GitHub
            </a>
            <Link
              href="/docs"
              className="bg-white text-blue-600 px-8 py-3 rounded-lg font-semibold border-2 border-blue-600 hover:bg-blue-50 transition"
            >
              Learn More
            </Link>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-white rounded-lg p-6 shadow-md">
            <div className="text-3xl mb-3">🐛</div>
            <h3 className="font-bold text-lg mb-2">Fix Bugs</h3>
            <p className="text-gray-600">
              Label an issue with `agent` and get a PR with the fix automatically
            </p>
          </div>

          <div className="bg-white rounded-lg p-6 shadow-md">
            <div className="text-3xl mb-3">✨</div>
            <h3 className="font-bold text-lg mb-2">Implement Features</h3>
            <p className="text-gray-600">
              Describe what you want built, and the agent creates a complete implementation
            </p>
          </div>

          <div className="bg-white rounded-lg p-6 shadow-md">
            <div className="text-3xl mb-3">📝</div>
            <h3 className="font-bold text-lg mb-2">Review Code</h3>
            <p className="text-gray-600">
              Automatically review PRs for quality, security, and best practices
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
