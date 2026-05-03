import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const url = request.nextUrl

  // Check if accessing dashboard without session cookie
  if (url.pathname.startsWith('/dashboard')) {
    const sessionToken = request.cookies.get('next-auth.session-token')?.value
    const sessionTokenSecure = request.cookies.get('next-auth.session-token.secure')?.value

    // If no session token, redirect to signin
    if (!sessionToken && !sessionTokenSecure) {
      return NextResponse.redirect(new URL('/signin', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*'],
}
