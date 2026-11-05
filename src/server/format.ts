import { spawn } from "node:child_process";

export type FormatResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Formats a Caddyfile with `caddy fmt`, the same formatter Caddy uses for its
 * "input is not formatted" warning. It only normalises whitespace and does not validate.
 */
export function formatCaddyfile(text: string, bin: string): Promise<FormatResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["fmt", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (result: FormatResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: "caddy fmt timed out" });
    }, 10_000);

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        error:
          error.code === "ENOENT"
            ? `The caddy binary was not found (${bin}), so formatting is unavailable.`
            : error.message,
      }),
    );
    child.on("close", (code) => {
      if (code !== 0) {
        return finish({ ok: false, error: Buffer.concat(err).toString("utf8").trim() || `caddy fmt exited with ${code}` });
      }
      const formatted = Buffer.concat(out).toString("utf8");
      finish({ ok: true, text: formatted, changed: formatted !== text });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(text);
  });
}
