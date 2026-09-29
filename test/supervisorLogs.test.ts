import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LogBuffer } from '../src/lib/supervisor/logs';

describe('LogBuffer', () => {
  it('splits chunks into lines and keeps partial lines per stream', () => {
    const b = new LogBuffer();
    b.push('out', 'hello wo');
    b.push('err', 'boom\n');
    b.push('out', 'rld\nnext\r\n');
    expect(b.tail(10).map(l => `${l.stream}:${l.text}`)).toEqual(['err:boom', 'out:hello world', 'out:next']);
  });
  it('keeps only the last maxLines in memory', () => {
    const b = new LogBuffer({ maxLines: 3 });
    for (let i = 0; i < 10; i++) b.push('out', `${i}\n`);
    expect(b.tail(100).map(l => l.text)).toEqual(['7', '8', '9']);
    expect(b.tail(0)).toEqual([]);
  });
  it('writes to file and rotates keeping 2 old files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmp-logs-'));
    const file = path.join(dir, 'w.log');
    const b = new LogBuffer({ file, maxBytes: 200, keepFiles: 2 });
    for (let i = 0; i < 40; i++) b.push('out', `line ${i} ${'x'.repeat(20)}\n`);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(true);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.readFileSync(file, 'utf8')).toContain('line 39');
  });
});
