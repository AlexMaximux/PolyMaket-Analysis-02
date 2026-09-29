import fs from 'fs';
import path from 'path';

export type LogStream = 'out' | 'err' | 'sys';
export interface LogLine {
  t: number;
  stream: LogStream;
  text: string;
}

export interface LogBufferOptions {
  file?: string | null;
  maxLines?: number;
  maxBytes?: number;
  keepFiles?: number;
}

/** Last N lines in memory for the dashboard, plus a size-rotated log file. */
export class LogBuffer {
  private lines: LogLine[] = [];
  private partial: Record<LogStream, string> = { out: '', err: '', sys: '' };
  private size = 0;
  private readonly file: string | null;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly keepFiles: number;

  constructor(opts: LogBufferOptions = {}) {
    this.file = opts.file ?? null;
    this.maxLines = opts.maxLines ?? 500;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.keepFiles = opts.keepFiles ?? 2;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        this.size = fs.statSync(this.file).size;
      } catch {
        this.size = 0;
      }
    }
  }

  push(stream: LogStream, chunk: string): void {
    const parts = (this.partial[stream] + chunk).split('\n');
    this.partial[stream] = parts.pop() ?? '';
    for (const p of parts) this.add(stream, p.replace(/\r$/, ''));
  }

  tail(n: number): LogLine[] {
    return n > 0 ? this.lines.slice(-n) : [];
  }

  private add(stream: LogStream, text: string) {
    const line = { t: Date.now(), stream, text };
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    if (this.file) this.write(`${new Date(line.t).toISOString()} [${stream}] ${text}\n`);
  }

  private write(s: string) {
    try {
      const bytes = Buffer.byteLength(s);
      if (this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file!, s);
      this.size += bytes;
    } catch {
      // disk problems must not take the supervisor down
    }
  }

  private rotate() {
    for (let i = this.keepFiles; i >= 1; i--) {
      const src = i === 1 ? this.file! : `${this.file}.${i - 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${this.file}.${i}`);
    }
    this.size = 0;
  }
}
