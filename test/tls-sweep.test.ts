import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SWEEP_MS, TlsSweep } from "../src/server/tls-sweep.js";
import type { HostProbe } from "../src/server/tls-probe.js";

type Sev = "ok" | "amber" | "red";

const probe = (severity: Sev, reasons: string[] = []): HostProbe => ({
  result: { ok: false, error: "x" },
  assessment: { severity, reasons },
  checkedAt: "2030-01-01T00:00:00.000Z",
  cached: false,
});

function setup(opts: { enabled?: boolean; hosts?: () => Promise<string[]>; severities?: Record<string, Sev> } = {}) {
  const checked: { host: string; force?: boolean }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const severities = opts.severities ?? {};
  const sweep = new TlsSweep({
    prober: {
      enabled: opts.enabled ?? true,
      check: async (host: string, o?: { force?: boolean }) => {
        checked.push({ host, force: o?.force });
        if (host === "boom.test") throw new Error("boom");
        return probe(severities[host] ?? "ok", [`${host} reason`]);
      },
    },
    listHosts: opts.hosts ?? (async () => ["a.test", "b.test"]),
    now: () => Date.parse("2030-01-01T00:00:00Z"),
    schedule: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return () => {
        t.cleared = true;
      };
    },
  });
  return { sweep, checked, timers };
}

describe("TlsSweep", () => {
  it("sweeps on startup and schedules every 6 hours", async () => {
    const { sweep, checked, timers } = setup();
    await sweep.start();
    assert.deepEqual(
      checked.map((c) => c.host),
      ["a.test", "b.test"],
    );
    assert.equal(checked[0].force, true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 6 * 3_600_000);
    assert.equal(SWEEP_MS, 6 * 3_600_000);
  });

  it("sweeps again when the timer fires", async () => {
    const { sweep, checked, timers } = setup();
    await sweep.start();
    timers[0].fn();
    await sweep.sweepOnce();
    assert.equal(checked.length, 4);
  });

  it("does nothing when probing is disabled", async () => {
    let listed = false;
    const { sweep, checked, timers } = setup({
      enabled: false,
      hosts: async () => {
        listed = true;
        return ["a.test"];
      },
    });
    await sweep.start();
    assert.equal(listed, false);
    assert.equal(checked.length, 0);
    assert.equal(timers.length, 0);
    assert.deepEqual(sweep.snapshot(), { ok: true, enabled: false, hosts: {} });
  });

  it("stop clears the timer", async () => {
    const { sweep, timers } = setup();
    await sweep.start();
    sweep.stop();
    assert.equal(timers[0].cleared, true);
  });

  it("snapshot holds severity and reasons per host, and forgets removed hosts", async () => {
    let hosts = ["a.test", "b.test"];
    const { sweep } = setup({ hosts: async () => hosts, severities: { "a.test": "red", "b.test": "amber" } });
    await sweep.start();
    const snap = sweep.snapshot();
    assert.equal(snap.enabled, true);
    assert.equal(snap.sweptAt, "2030-01-01T00:00:00.000Z");
    assert.deepEqual(snap.hosts["a.test"], { severity: "red", reasons: ["a.test reason"] });
    assert.equal(snap.hosts["b.test"].severity, "amber");
    hosts = ["b.test"];
    await sweep.sweepOnce();
    assert.deepEqual(Object.keys(sweep.snapshot().hosts), ["b.test"]);
  });

  it("a failing probe does not stop the sweep or leave a stale result", async () => {
    const { sweep } = setup({ hosts: async () => ["boom.test", "a.test"] });
    await sweep.start();
    assert.deepEqual(Object.keys(sweep.snapshot().hosts), ["a.test"]);
  });

  it("keeps the previous results when the host list cannot be read", async () => {
    let fail = false;
    const { sweep } = setup({
      hosts: async () => {
        if (fail) throw new Error("caddy down");
        return ["a.test"];
      },
    });
    await sweep.start();
    fail = true;
    await sweep.sweepOnce();
    assert.deepEqual(Object.keys(sweep.snapshot().hosts), ["a.test"]);
  });

  it("does not run overlapping sweeps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sweep, checked } = setup({
      hosts: async () => {
        await gate;
        return ["a.test"];
      },
    });
    const first = sweep.sweepOnce();
    const second = sweep.sweepOnce();
    release();
    await Promise.all([first, second]);
    assert.equal(checked.length, 1);
  });
});
