import Link from 'next/link'
import { FiGithub, FiTwitter } from 'react-icons/fi'

export function Footer() {
  return (
    <footer className="bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div>
            <h3 className="font-bold text-lg mb-4">Agent</h3>
            <p className="text-gray-400">
              Autonomous coding agent for GitHub
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-gray-400">
              <li><Link href="/" className="hover:text-white">Home</Link></li>
              <li><Link href="/docs" className="hover:text-white">Documentation</Link></li>
              <li><Link href="/pricing" className="hover:text-white">Pricing</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Resources</h4>
            <ul className="space-y-2 text-gray-400">
              <li><a href="https://github.com/cenetex/agent" className="hover:text-white">GitHub</a></li>
              <li><a href="https://github.com/cenetex/agent/issues" className="hover:text-white">Issues</a></li>
              <li><a href="https://github.com/cenetex/agent/discussions" className="hover:text-white">Discussions</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Follow</h4>
            <div className="flex space-x-4">
              <a href="https://github.com/cenetex/agent" className="text-gray-400 hover:text-white">
                <FiGithub className="w-6 h-6" />
              </a>
              <a href="https://twitter.com/search?q=cenetex%20agent" className="text-gray-400 hover:text-white">
                <FiTwitter className="w-6 h-6" />
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-8 flex flex-col md:flex-row justify-between items-center">
          <p className="text-gray-400 text-sm">
            © 2026 Cenetex. Agent is open source under MIT License.
          </p>
          <p className="text-gray-400 text-sm mt-4 md:mt-0">
            <a href="/privacy" className="hover:text-white">Privacy</a>
            {' '} · {' '}
            <a href="/terms" className="hover:text-white">Terms</a>
          </p>
        </div>
      </div>
    </footer>
  )
}
