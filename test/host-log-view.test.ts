import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newestFirst, visibleRows } from "../web/src/lib/host-log-view.js";

const rows = [{ id: 3 }, { id: 4 }, { id: 5 }];

describe("visibleRows", () => {
  it("shows everything when nothing is held back", () => {
    assert.deepEqual(visibleRows(rows, null), { shown: rows, held: 0 });
  });
  it("holds back rows that arrived after the given id", () => {
    assert.deepEqual(visibleRows(rows, 4), { shown: [{ id: 3 }, { id: 4 }], held: 1 });
  });
  it("holds back everything when the list was empty", () => {
    assert.deepEqual(visibleRows(rows, -1), { shown: [], held: 3 });
  });
});

describe("newestFirst", () => {
  it("reverses without changing the input", () => {
    assert.deepEqual(newestFirst(rows).map((r) => r.id), [5, 4, 3]);
    assert.deepEqual(rows.map((r) => r.id), [3, 4, 5]);
  });
});
