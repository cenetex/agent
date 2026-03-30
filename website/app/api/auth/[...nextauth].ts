import NextAuth from "next-auth"
import GithubProvider from "next-auth/providers/github"
import { JWT } from "next-auth/jwt"
import { Session, User } from "next-auth"
import "@/types/nextauth-ext"

export const authOptions = {
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_ID || "",
      clientSecret: process.env.GITHUB_SECRET || "",
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  pages: {
    signIn: "/signin",
    error: "/auth/error",
  },
  callbacks: {
    async jwt({ token, user }: { token: JWT; user?: User }) {
      if (user) {
        token.id = user.id
      }
      return token
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      if (session.user) {
        session.user.id = token.id as string
      }
      return session
    },
  },
}

export const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
