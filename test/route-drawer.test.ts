import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DRAWER_WIDTH,
  MIN_DRAWER_WIDTH,
  activeTab,
  clampDrawerWidth,
  drawerTabs,
  nodeKind,
  parseStoredWidth,
} from "../web/src/lib/route-drawer.js";

describe("nodeKind", () => {
  it("derives the kind from the graph node id", () => {
    assert.equal(nodeKind("host:example.com|:443"), "host");
    assert.equal(nodeKind("handler:encode"), "rule");
    assert.equal(nodeKind("host-group:example.com"), "group");
    assert.equal(nodeKind("dest-group:10.0.0.0/8"), "group");
    assert.equal(nodeKind("proxy:app:8080"), "destination");
    assert.equal(nodeKind("file:/srv"), "destination");
  });
});

describe("clampDrawerWidth", () => {
  it("keeps the width between the minimum and 70% of the available space", () => {
    assert.equal(clampDrawerWidth(10, 1000), MIN_DRAWER_WIDTH);
    assert.equal(clampDrawerWidth(500, 1000), 500);
    assert.equal(clampDrawerWidth(990, 1000), 700);
  });
  it("never goes below the minimum in a narrow container", () => {
    assert.equal(clampDrawerWidth(300, 100), MIN_DRAWER_WIDTH);
  });
});

describe("parseStoredWidth", () => {
  it("returns a stored number and falls back to the default otherwise", () => {
    assert.equal(parseStoredWidth("320"), 320);
    assert.equal(parseStoredWidth(null), DEFAULT_DRAWER_WIDTH);
    assert.equal(parseStoredWidth("abc"), DEFAULT_DRAWER_WIDTH);
    assert.equal(parseStoredWidth("-5"), DEFAULT_DRAWER_WIDTH);
  });
});

describe("drawer tabs", () => {
  it("offers Overview and Logs for hosts only", () => {
    assert.deepEqual(drawerTabs("host"), ["overview", "logs"]);
    assert.deepEqual(drawerTabs("group"), []);
    assert.deepEqual(drawerTabs("rule"), []);
    assert.deepEqual(drawerTabs("destination"), []);
  });
  it("keeps the selected tab when the node has it, else falls back to the overview", () => {
    assert.equal(activeTab("host", "logs"), "logs");
    assert.equal(activeTab("group", "logs"), "overview");
    assert.equal(activeTab("rule", "logs"), "overview");
  });
});
