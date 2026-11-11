/** Small helpers for the JSON state files in DATA_DIR. */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
export async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), mode === undefined ? undefined : { mode });
  await rename(tmp, file);
}
