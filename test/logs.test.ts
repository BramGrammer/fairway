import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LogFollower, tailLines } from "../src/server/logs.js";

describe("logs", () => {
  it("returns the last lines of a file and tolerates a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ce-log-"));
    const path = join(dir, "access.log");
    assert.deepEqual(await tailLines(path, 5), []);
    await writeFile(path, "a\nb\nc\nd\n");
    assert.deepEqual(await tailLines(path, 2), ["c", "d"]);
  });

  it("follows appended lines, holds back partial lines, and survives rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ce-log-"));
    const path = join(dir, "access.log");
    await writeFile(path, "old\n");
    const seen: string[] = [];
    const follower = new LogFollower(path, (lines) => seen.push(...lines), 20);
    await follower.start();

    await appendFile(path, "one\ntw");
    await sleep(80);
    assert.deepEqual(seen, ["one"]);

    await appendFile(path, "o\n");
    await sleep(80);
    assert.deepEqual(seen, ["one", "two"]);

    await rename(path, join(dir, "access-rotated.log"));
    await writeFile(path, "three\n");
    await sleep(80);
    assert.deepEqual(seen, ["one", "two", "three"]);
    follower.stop();
  });
});
