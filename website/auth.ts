import type { NextAuthOptions } from 'next-auth'
import GitHub from 'next-auth/providers/github'

export const authOptions: NextAuthOptions = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID || '',
      clientSecret: process.env.GITHUB_SECRET || '',
    }),
  ],
  pages: {
    signIn: '/signin',
  },
  callbacks: {
    redirect: async ({ url, baseUrl }) => {
      if (url.startsWith('/')) return `${baseUrl}${url}`
      return url.startsWith(baseUrl) ? url : baseUrl
    },
  },
}

export { signIn, signOut } from 'next-auth/react'
