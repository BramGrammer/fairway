import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatCaddyfile } from "../src/server/format.js";

async function stub(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "ce-fmt-"));
  const path = join(dir, "caddy");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("formatCaddyfile", () => {
  it("pipes the text through `caddy fmt -` and reports whether it changed", async () => {
    const bin = await stub('[ "$1 $2" = "fmt -" ] || exit 2\ntr a-z A-Z');
    const changed = await formatCaddyfile("a.com {\n}\n", bin);
    assert.deepEqual(changed, { ok: true, text: "A.COM {\n}\n", changed: true });
    const same = await formatCaddyfile("A.COM\n", bin);
    assert.deepEqual(same, { ok: true, text: "A.COM\n", changed: false });
  });

  it("returns caddy's stderr when it fails", async () => {
    const bin = await stub('echo "boom: bad input" >&2\nexit 1');
    assert.deepEqual(await formatCaddyfile("x", bin), { ok: false, error: "boom: bad input" });
  });

  it("explains when the binary is missing", async () => {
    const result = await formatCaddyfile("x", "/nonexistent/caddy");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /binary was not found/);
  });
});
