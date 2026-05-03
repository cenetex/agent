'use client'

import { signIn } from 'next-auth/react'

export default function SignIn() {
  const handleGitHubSignIn = async () => {
    await signIn('github', { redirect: true, callbackUrl: '/dashboard' })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-center mb-2">Sign in to Dashboard</h1>
        <p className="text-center text-gray-600 mb-8">
          Manage your credits and view task history
        </p>

        <button
          onClick={handleGitHubSignIn}
          className="w-full bg-gray-800 hover:bg-gray-900 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors"
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.868-.013-1.703-2.782.603-3.369-1.343-3.369-1.343-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.544 2.914 1.19.092-.926.35-1.557.636-1.914-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.270.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0110 4.817c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.193 20 14.434 20 10.017 20 4.484 15.522 0 10 0z" clipRule="evenodd" />
          </svg>
          Sign in with GitHub
        </button>

        <p className="text-center text-gray-600 mt-6 text-sm">
          We only use your GitHub account to verify your identity and show your repository credits.
        </p>
      </div>
    </div>
  )
}
