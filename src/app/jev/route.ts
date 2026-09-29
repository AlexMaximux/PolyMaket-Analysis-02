import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { generateJevSnapshot } from '@/lib/jevSnapshot';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'jev', 'btc_updown.json');
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return NextResponse.json(data);
    }
    const fresh = await generateJevSnapshot();
    return NextResponse.json(fresh);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to fetch jev data' }, { status: 500 });
  }
}
