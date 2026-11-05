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
