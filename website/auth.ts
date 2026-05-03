import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import type { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user?: DefaultSession['user'] & {
      id: string
    }
  }
}

const authConfig = {
  providers: [
    GitHub({
      clientId: process.env.GITHUB_ID || '',
      clientSecret: process.env.GITHUB_SECRET || '',
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  pages: {
    signIn: '/signin',
  },
  session: {
    strategy: 'jwt' as const,
  },
  callbacks: {
    async jwt({ token, user }: { token: any; user?: any }) {
      if (user) {
        token.id = user.id
      }
      return token
    },
    async session({ session, token }: { session: any; token: any }) {
      if (session.user) {
        session.user.id = token.id as string
      }
      return session
    },
  },
}

export const { auth, signIn, signOut } = NextAuth(authConfig)
