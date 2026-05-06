'use client'

import { signOut } from 'next-auth/react'

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: '/' })}
      className="px-4 py-2 text-gray-700 hover:bg-red-50 rounded text-sm"
    >
      Sign Out
    </button>
  )
}
