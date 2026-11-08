import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PANEL_ROWS, panelRows, splitMembers } from "../web/src/lib/group-panel.js";

const members = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

describe("splitMembers", () => {
  it("shows everything in a small group", () => {
    assert.deepEqual(splitMembers(members(3), null), { shown: members(3), hidden: [] });
  });

  it("folds the rest of a big group", () => {
    const { shown, hidden } = splitMembers(members(13), null);
    assert.equal(shown.length, PANEL_ROWS);
    assert.equal(hidden.length, 13 - PANEL_ROWS);
  });

  it("always shows the selected member, even from the folded part", () => {
    const { shown, hidden } = splitMembers(members(13), "m10");
    assert.ok(shown.includes("m10"));
    assert.ok(!hidden.includes("m10"));
    assert.equal(shown.length + hidden.length, 13);
  });

  it("shows every member when asked to", () => {
    assert.deepEqual(splitMembers(members(13), null, true), { shown: members(13), hidden: [] });
  });

  it("ignores a selection that is not in the group", () => {
    assert.equal(splitMembers(members(13), "other").shown.length, PANEL_ROWS);
  });
});

describe("panelRows", () => {
  it("puts each row centre inside the panel, in order", () => {
    const { centers, height } = panelRows([30, 30, 30]);
    assert.equal(centers.length, 3);
    assert.ok(centers[0] < centers[1] && centers[1] < centers[2]);
    assert.ok(centers[2] < height);
  });

  it("grows with the number and height of the rows", () => {
    assert.ok(panelRows([30, 30, 30]).height > panelRows([30, 30]).height);
    assert.ok(panelRows([42, 42]).height > panelRows([30, 30]).height);
  });

  it("lets rows differ in height", () => {
    const { centers } = panelRows([42, 30]);
    assert.equal(centers[1] - centers[0], 42 / 2 + 4 + 30 / 2);
  });
});
