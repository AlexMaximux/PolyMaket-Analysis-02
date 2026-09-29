import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getOpenRouterCredit, type OpenRouterCredit } from '@/lib/openrouterCredit';

export const dynamic = 'force-dynamic';

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fileSize(p);
  }
  return total;
}

export async function GET() {
  const root = process.cwd();
  let openrouter: OpenRouterCredit | null = null;
  let openrouterError: string | null = null;
  try {
    openrouter = await getOpenRouterCredit();
  } catch (e) {
    openrouterError = (e as Error).message;
  }
  return NextResponse.json({
    dbBytes: fileSize(path.join(root, 'updown.db')),
    walBytes: fileSize(path.join(root, 'updown.db-wal')),
    jevBytes: dirSize(path.join(root, 'jev')),
    openrouter,
    openrouterError,
  });
}
