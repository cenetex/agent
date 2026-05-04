import type { Metadata } from 'next'
import './globals.css'
import { Navigation } from '@/components/navigation'
import { Footer } from '@/components/footer'
import { SessionProvider } from '@/components/session-provider'

export const metadata: Metadata = {
  title: 'Agent - Autonomous GitHub Coding Agent',
  description: 'Autonomous coding agent that fixes bugs, implements features, and reviews PRs on GitHub',
  keywords: ['GitHub', 'AI', 'Coding Agent', 'Automation', 'CI/CD'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-white">
        <SessionProvider>
          <Navigation />
          <main className="min-h-screen">
            {children}
          </main>
          <Footer />
        </SessionProvider>
      </body>
    </html>
  )
}
