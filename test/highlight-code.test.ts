import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HighlightStyle } from "../web/node_modules/@codemirror/language/dist/index.js";
import { tags } from "../web/node_modules/@lezer/highlight/dist/index.js";
import { highlightCaddyfile } from "../web/src/lib/highlight-code.js";

describe("highlightCaddyfile", () => {
  it("keeps the text and classes the tokens", () => {
    const style = HighlightStyle.define([
      { tag: tags.keyword, color: "red" },
      { tag: tags.string, color: "green" },
    ]);
    const code = 'a.test {\n\trespond "hi"\n}';
    const spans = highlightCaddyfile(code, style);
    assert.equal(spans.map((s) => s.text).join(""), code);
    assert.ok(spans.find((s) => s.text === "respond")?.className);
    assert.ok(spans.find((s) => s.text === '"hi"')?.className);
    assert.equal(spans.find((s) => s.text === "\t")?.className ?? "", "");
  });
});
