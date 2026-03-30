import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-8">
            <Link href="/" className="text-2xl font-bold text-blue-600">
              Agent
            </Link>
            <div className="hidden md:flex gap-6">
              <Link href="/docs" className="text-gray-600 hover:text-gray-900">
                Docs
              </Link>
              <Link href="/#pricing" className="text-gray-600 hover:text-gray-900">
                Pricing
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&scope=repo"
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Sign In
            </a>
            <a
              href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&scope=repo"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
            >
              Install App
            </a>
          </div>
        </div>
      </div>
    </nav>
  );
}
