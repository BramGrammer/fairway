import { open, stat } from "node:fs/promises";

/** The last `count` complete lines of a file, reading only its tail. */
export async function tailLines(path: string, count: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    // A tail read may start mid-line.
    if (length < size) lines.shift();
    return lines.slice(-count);
  } finally {
    await handle.close();
  }
}

/**
 * Walks a file's complete lines from the newest to the oldest, reading backwards in chunks.
 * Stops when `visit` returns true, at the start of the file, or after `maxBytes` bytes, so a huge
 * file is never loaded whole. A line cut off by the byte limit is dropped. Missing files yield nothing.
 */
export async function scanLinesBackward(
  path: string,
  visit: (line: string) => boolean | void,
  maxBytes = 8 * 1024 * 1024,
  chunkSize = 128 * 1024,
): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    let position = size;
    let scanned = 0;
    let carry: Buffer = Buffer.alloc(0);
    while (position > 0 && scanned < maxBytes) {
      const length = Math.min(chunkSize, position, maxBytes - scanned);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position - length);
      position -= length;
      scanned += length;
      const data = Buffer.concat([chunk, carry]);
      const parts = data.toString("utf8").split("\n");
      // The first part may continue in the chunk before this one.
      const first = parts.shift() ?? "";
      carry = Buffer.from(first, "utf8");
      for (let i = parts.length - 1; i >= 0; i--) {
        const line = parts[i];
        if (line && visit(line) === true) return;
      }
    }
    if (position === 0 && carry.length > 0) visit(carry.toString("utf8"));
  } finally {
    await handle.close();
  }
}

/** Follows a growing log file, starting at its end and surviving rotation and truncation. */
export class LogFollower {
  private timer: NodeJS.Timeout | undefined;
  private offset = 0;
  private inode = 0;
  private partial = "";
  private busy = false;

  constructor(
    private readonly path: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly intervalMs = 500,
  ) {}

  async start(): Promise<void> {
    try {
      const info = await stat(this.path);
      this.offset = info.size;
      this.inode = info.ino;
    } catch {
      // The file may not exist yet.
    }
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const info = await stat(this.path);
      if (info.ino !== this.inode || info.size < this.offset) {
        this.offset = 0;
        this.partial = "";
        this.inode = info.ino;
      }
      if (info.size === this.offset) return;
      const handle = await open(this.path, "r");
      try {
        const length = info.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = info.size;
        const text = this.partial + buffer.toString("utf8");
        const lines = text.split("\n");
        this.partial = lines.pop() ?? "";
        const complete = lines.filter(Boolean);
        if (complete.length > 0) this.onLines(complete);
      } finally {
        await handle.close();
      }
    } catch {
      // The file is missing or mid-rotation. Try again on the next tick.
    } finally {
      this.busy = false;
    }
  }
}
