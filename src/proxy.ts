import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { checkLocalRequest } from '@/lib/requestGuard';

export function proxy(request: NextRequest) {
  const reason = checkLocalRequest(request.method, request.headers.get('host'), request.headers.get('origin'));
  if (reason) return NextResponse.json({ error: `forbidden: ${reason}` }, { status: 403 });
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
