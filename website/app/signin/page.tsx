'use client'

import { signIn } from 'next-auth/react'
import { FiGithub } from 'react-icons/fi'

export default function SignIn() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
        <h1 className="text-3xl font-bold text-center mb-2">Sign in to Dashboard</h1>
        <p className="text-center text-gray-600 mb-8">
          Manage your credits and view task history
        </p>

        <button
          onClick={() => signIn('github', { redirect: true, callbackUrl: '/dashboard' })}
          className="w-full flex items-center justify-center gap-2 bg-gray-900 text-white px-4 py-3 rounded-lg hover:bg-gray-800 transition font-semibold"
        >
          <FiGithub className="w-5 h-5" />
          Sign in with GitHub
        </button>

        <p className="text-center text-gray-600 mt-6 text-sm">
          We only use your GitHub account to verify your identity and show your repository credits.
        </p>
      </div>
    </div>
  )
}
