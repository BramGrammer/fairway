import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function readCaddyfile(path: string): Promise<{ text: string; hash: string }> {
  const text = await readFile(path, "utf8");
  return { text, hash: hashText(text) };
}

/**
 * Caddy mounts the Caddyfile as a single file, so replacing it (write temp + rename)
 * would leave Caddy looking at the old inode. Truncate and write the same file instead.
 */
export async function writeInPlace(path: string, text: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(0);
    await handle.write(text, 0, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
