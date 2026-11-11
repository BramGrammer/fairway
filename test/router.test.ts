import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUrl,
  isPlainClick,
  pageTitle,
  parseParams,
  patchParams,
  resolveLocation,
} from "../web/src/lib/router.js";

const at = (pathname: string, search = "", hash = "") => resolveLocation({ pathname, search, hash });

describe("resolveLocation", () => {
  it("shows each page at its own path without a redirect", () => {
    for (const page of ["editor", "routes", "history", "events", "logs"]) {
      const resolved = at(`/${page}`);
      assert.equal(resolved.page, page);
      assert.equal(resolved.redirect, null);
    }
  });

  it("ignores a trailing slash", () => {
    assert.deepEqual(at("/routes/"), { page: "routes", params: {}, redirect: null });
  });

  it("redirects the root to the editor and keeps the query", () => {
    const resolved = at("/", "?settings=alerts");
    assert.equal(resolved.page, "editor");
    assert.equal(resolved.redirect, "/editor?settings=alerts");
    assert.equal(resolved.params.settings, "alerts");
  });

  it("redirects an unknown path to the editor", () => {
    assert.equal(at("/nope/deeper").redirect, "/editor");
    assert.equal(at("/nope/deeper").page, "editor");
  });

  it("turns an old hash link into a path", () => {
    const resolved = at("/", "", "#routes");
    assert.equal(resolved.page, "routes");
    assert.equal(resolved.redirect, "/routes");
    assert.equal(at("/", "?group=table", "#routes").redirect, "/routes?group=table");
  });

  it("ignores an unknown hash and a hash on a real path", () => {
    assert.equal(at("/", "", "#nothing").redirect, "/editor");
    assert.equal(at("/logs", "", "#routes").page, "logs");
  });
});

describe("parseParams", () => {
  it("reads the parameters of the routes page", () => {
    assert.deepEqual(parseParams("?group=destination&source=editor&q=app&node=host%3Aa.test", "routes"), {
      group: "destination",
      source: "editor",
      q: "app",
      node: "host:a.test",
    });
  });

  it("reads the settings dialog on every page and the revision on history", () => {
    assert.deepEqual(parseParams("?settings=monitoring", "logs"), { settings: "monitoring" });
    assert.deepEqual(parseParams("?revision=12", "history"), { revision: "12" });
    assert.deepEqual(parseParams("?revision=original", "history"), { revision: "original" });
  });

  it("drops values that are unknown or invalid", () => {
    assert.deepEqual(parseParams("?settings=x&group=graph&source=running&q=&node=", "routes"), {});
    assert.deepEqual(parseParams("?revision=../etc&", "history"), {});
    assert.deepEqual(parseParams(`?q=${"a".repeat(201)}`, "routes"), {});
  });

  it("drops parameters that belong to another page", () => {
    assert.deepEqual(parseParams("?group=table&revision=3", "editor"), {});
    assert.deepEqual(parseParams("?group=table", "history"), {});
  });
});

describe("buildUrl", () => {
  it("builds a bare path", () => {
    assert.equal(buildUrl("routes"), "/routes");
  });

  it("encodes parameters in a stable order", () => {
    assert.equal(
      buildUrl("routes", { node: "host:a b|:443", q: "x&y", source: "editor", group: "table" }),
      "/routes?group=table&source=editor&q=x%26y&node=host%3Aa+b%7C%3A443"
    );
  });

  it("leaves out parameters the page does not own", () => {
    assert.equal(buildUrl("history", { group: "table", revision: "2", settings: "general" }), "/history?settings=general&revision=2");
  });

  it("round trips through parseParams", () => {
    const params = { group: "destination", source: "editor", q: "a b&c=d", node: "proxy:app:8080" } as const;
    const url = new URL(buildUrl("routes", params), "http://x");
    assert.deepEqual(parseParams(url.search, "routes"), params);
  });
});

describe("patchParams", () => {
  it("sets, replaces and removes", () => {
    assert.deepEqual(patchParams({ q: "a" }, { group: "table" }), { q: "a", group: "table" });
    assert.deepEqual(patchParams({ q: "a" }, { q: "b" }), { q: "b" });
    assert.deepEqual(patchParams({ q: "a", node: "n" }, { q: undefined }), { node: "n" });
    assert.deepEqual(patchParams({ q: "a" }, { q: "" }), {});
  });
});

describe("isPlainClick", () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  it("handles only a plain left click", () => {
    assert.equal(isPlainClick(base), true);
    assert.equal(isPlainClick({ ...base, metaKey: true }), false);
    assert.equal(isPlainClick({ ...base, ctrlKey: true }), false);
    assert.equal(isPlainClick({ ...base, button: 1 }), false);
    assert.equal(isPlainClick({ ...base, defaultPrevented: true }), false);
  });
});

describe("pageTitle", () => {
  it("names the page", () => {
    assert.equal(pageTitle("routes"), "Routes · Fairway");
  });
});
