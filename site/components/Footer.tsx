import Link from "next/link";

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div>
            <h3 className="text-white font-bold mb-4">Agent</h3>
            <p className="text-sm">
              Autonomous coding agent for GitHub. Fixes bugs, implements features, and reviews code.
            </p>
          </div>
          <div>
            <h3 className="text-white font-bold mb-4">Product</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/" className="hover:text-white">
                  Home
                </Link>
              </li>
              <li>
                <Link href="/#pricing" className="hover:text-white">
                  Pricing
                </Link>
              </li>
              <li>
                <a href="https://github.com/cenetex/agent" className="hover:text-white">
                  GitHub
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-white font-bold mb-4">Documentation</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/docs" className="hover:text-white">
                  Getting Started
                </Link>
              </li>
              <li>
                <a href="/docs#credits" className="hover:text-white">
                  Credit System
                </a>
              </li>
              <li>
                <a href="/docs#configuration" className="hover:text-white">
                  Configuration
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-white font-bold mb-4">Company</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="https://cenetex.com" className="hover:text-white">
                  About
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white">
                  Contact
                </a>
              </li>
              <li>
                <a href="#" className="hover:text-white">
                  Privacy
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-800 pt-8 text-center text-sm">
          <p>&copy; 2024 Cenetex. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
