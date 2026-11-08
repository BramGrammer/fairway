import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countCrossings, orderLayers, type Layers, type Link } from "../web/src/lib/graph-order.js";

const unit = (key: string, ...members: string[]) => ({ key, members });
const single = (...ids: string[]) => ids.map((id) => unit(id, id));

describe("orderLayers", () => {
  it("untangles crossing lines across three columns", () => {
    const links: Link[] = [["a", "m1"], ["b", "m2"], ["m1", "x"], ["m2", "y"]];
    const start: Layers = [single("a", "b"), single("m2", "m1"), single("x", "y")];
    assert.equal(countCrossings(links, start), 2);
    assert.equal(countCrossings(links, orderLayers(links, start)), 0);
  });

  it("orders more than one middle column", () => {
    const links: Link[] = [["a", "p"], ["b", "q"], ["p", "r"], ["q", "s"], ["r", "x"], ["s", "y"]];
    const start: Layers = [single("a", "b"), single("q", "p"), single("s", "r"), single("y", "x")];
    assert.ok(countCrossings(links, start) > 0);
    assert.equal(countCrossings(links, orderLayers(links, start)), 0);
  });

  it("never does worse than the order it starts from", () => {
    const links: Link[] = [];
    for (let h = 0; h < 8; h++) for (let k = 0; k < 3; k++) links.push([`h${h}`, `m${(h * 5 + k) % 4}`], [`m${(h * 5 + k) % 4}`, `d${(h + k * 3) % 5}`]);
    const start: Layers = [
      Array.from({ length: 8 }, (_, h) => unit(`H${h}`, `h${h}`)),
      single("m0", "m1", "m2", "m3"),
      Array.from({ length: 5 }, (_, d) => unit(`D${d}`, `d${d}`)),
    ];
    assert.ok(countCrossings(links, orderLayers(links, start)) <= countCrossings(links, start));
  });

  it("keeps the members of a unit together and loses no nodes", () => {
    const links: Link[] = [["a1", "m2"], ["b1", "m1"], ["a2", "m1"], ["m2", "x"], ["m1", "y"]];
    const start: Layers = [[unit("A", "a1", "a2"), unit("B", "b1")], single("m1", "m2"), single("x", "y")];
    const result = orderLayers(links, start);
    assert.deepEqual(result[0].map((u) => [...u.members].sort()).sort(), [["a1", "a2"], ["b1"]]);
    assert.deepEqual(result[1].flatMap((u) => u.members).sort(), ["m1", "m2"]);
    assert.equal(result[2].flatMap((u) => u.members).length, 2);
  });
});
