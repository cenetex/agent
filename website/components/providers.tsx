'use client'

import { SessionProvider } from 'next-auth/react'
import type { ReactNode } from 'react'

export function Providers({ children, session }: { children: ReactNode; session: any }) {
  return <SessionProvider session={session}>{children}</SessionProvider>
}
