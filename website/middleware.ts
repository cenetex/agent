import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const isOnDashboard = request.nextUrl.pathname.startsWith('/dashboard')
  const sessionToken = request.cookies.get('authjs.session-token')?.value

  if (isOnDashboard && !sessionToken) {
    return NextResponse.redirect(new URL('/signin', request.url))
  }
}

export const config = {
  matcher: ['/dashboard/:path*'],
}
