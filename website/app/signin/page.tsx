export default function SignIn() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-center mb-2">Sign in to Dashboard</h1>
        <p className="text-center text-gray-600 mb-8">
          Manage your credits and view task history
        </p>

        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-yellow-800 text-sm">
            GitHub OAuth sign-in is coming soon. Contact us at{' '}
            <a href="https://github.com/cenetex/agent" className="text-blue-600 hover:text-blue-700 font-medium">
              github.com/cenetex/agent
            </a>{' '}
            to get started.
          </p>
        </div>

        <p className="text-center text-gray-600 mt-6 text-sm">
          We only use your GitHub account to verify your identity and show your repository credits.
        </p>
      </div>
    </div>
  )
}
