import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { DeployError } from "../src/server/deploy.js";
import { setup } from "./helpers.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function fixture(...args: Parameters<typeof setup>) {
  const env = await setup(...args);
  closers.push(env.caddy.close);
  return env;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DeployError);
    return error.failure;
  }
  assert.fail("expected the deploy to fail");
}

describe("deploy", () => {
  it("saves the Original on first run and never changes it", async () => {
    const { store, deployer } = await fixture("original text\n");
    await deployer.deploy({ text: "new\n", baseHash: (await deployer.current()).hash });
    await deployer.ensureOriginal();
    assert.equal(await store.getOriginal(), "original text\n");
  });

  it("validates, writes the file in place, reloads and records a Revision", async () => {
    const { caddyfilePath, caddy, store, deployer } = await fixture();
    const before = await stat(caddyfilePath);
    const current = await deployer.current();

    const result = await deployer.deploy({ text: "changed {\n}\n", baseHash: current.hash, note: "tweak" });

    assert.equal(await readFile(caddyfilePath, "utf8"), "changed {\n}\n");
    assert.equal((await stat(caddyfilePath)).ino, before.ino, "inode must be preserved for Caddy's single-file mount");
    assert.deepEqual(caddy.loaded, ["changed {\n}\n"]);
    assert.equal(result.revision.kind, "deployed");
    assert.equal(result.revision.note, "tweak");
    assert.equal(store.list().length, 1);
  });

  it("rejects an invalid Caddyfile without touching the file or Caddy", async () => {
    const { caddyfilePath, caddy, deployer } = await fixture();
    const current = await deployer.current();

    const fail = await failure(deployer.deploy({ text: "BAD", baseHash: current.hash }));

    assert.equal(fail.code, "invalid");
    assert.equal(await readFile(caddyfilePath, "utf8"), current.text);
    assert.equal(caddy.loaded.length, 0);
  });

  it("rejects an empty Caddyfile", async () => {
    const { deployer } = await fixture();
    const fail = await failure(deployer.deploy({ text: "  \n", baseHash: (await deployer.current()).hash }));
    assert.equal(fail.code, "invalid");
  });

  it("restores the previous file when the reload fails and records nothing", async () => {
    const { caddyfilePath, store, deployer } = await fixture();
    const current = await deployer.current();

    const fail = await failure(deployer.deploy({ text: "LOADFAIL", baseHash: current.hash }));

    assert.equal(fail.code, "load_failed");
    assert.match(fail.message, /port already in use/);
    assert.equal(await readFile(caddyfilePath, "utf8"), current.text);
    assert.equal(store.list().length, 0);
  });

  it("refuses to overwrite a file that changed outside the editor", async () => {
    const { caddyfilePath, deployer } = await fixture();
    const stale = (await deployer.current()).hash;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(caddyfilePath, "edited by hand\n");

    const fail = await failure(deployer.deploy({ text: "mine\n", baseHash: stale }));

    assert.equal(fail.code, "conflict");
    assert.equal(await readFile(caddyfilePath, "utf8"), "edited by hand\n");
  });

  it("keeps an outside edit as a snapshot when forced to overwrite it", async () => {
    const { caddyfilePath, store, deployer } = await fixture();
    const stale = (await deployer.current()).hash;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(caddyfilePath, "edited by hand\n");

    await deployer.deploy({ text: "mine\n", baseHash: stale, force: true });

    const kinds = store.list().map((revision) => revision.kind).sort();
    assert.deepEqual(kinds, ["deployed", "external"]);
    const external = store.list().find((revision) => revision.kind === "external")!;
    assert.equal((await store.get(external.id))!.text, "edited by hand\n");
  });

  it("does not record a new Revision when nothing changed", async () => {
    const { deployer, store } = await fixture();
    await deployer.deploy({ text: "same\n", baseHash: (await deployer.current()).hash });
    const again = await deployer.deploy({ text: "same\n", baseHash: (await deployer.current()).hash });
    assert.equal(again.unchanged, true);
    assert.equal(store.list().length, 1);
  });

  it("prunes deployed Revisions beyond the limit but keeps the Original", async () => {
    const { deployer, store } = await fixture("start\n", 3);
    for (let i = 1; i <= 5; i++) {
      await deployer.deploy({ text: `v${i}\n`, baseHash: (await deployer.current()).hash });
    }
    assert.equal(store.list().length, 3);
    assert.deepEqual(store.list().map((revision) => revision.id), [5, 4, 3]);
    assert.equal(await store.getOriginal(), "start\n");
  });

  it("rolls back by deploying an earlier Revision", async () => {
    const { deployer, store, caddyfilePath } = await fixture();
    await deployer.deploy({ text: "v1\n", baseHash: (await deployer.current()).hash });
    await deployer.deploy({ text: "v2\n", baseHash: (await deployer.current()).hash });
    const first = store.list().at(-1)!;

    const result = await deployer.deploy({
      text: (await store.get(first.id))!.text,
      baseHash: (await deployer.current()).hash,
      rollbackOf: first.id,
    });

    assert.equal(await readFile(caddyfilePath, "utf8"), "v1\n");
    assert.equal(result.revision.rollbackOf, first.id);
  });

  it("serialises concurrent deploys", async () => {
    const { deployer, caddy } = await fixture();
    const hash = (await deployer.current()).hash;
    const results = await Promise.allSettled([
      deployer.deploy({ text: "a\n", baseHash: hash }),
      deployer.deploy({ text: "b\n", baseHash: hash }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "second one sees the first one's change");
    assert.equal(caddy.loaded.length, 1);
  });
});
