import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/setup', '/account/force-password-change'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get('vessel_auth_token');
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Static files are excluded by extension, not just by the `_next` prefix.
  //
  // Without that last alternative, anything served from `public/` — the SPARKS
  // logo, the favicon, a font — counts as a protected route and 307s to
  // /login for a signed-out visitor. That is invisible until a public page
  // references one: the sign-in screen asked for its own logo, was redirected
  // to itself, and rendered a broken image. Assets carry no data worth
  // protecting, and the ones on the sign-in page are needed precisely when
  // there is no session.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|xml|webmanifest|woff|woff2|ttf|otf)$).*)',
  ],
};
