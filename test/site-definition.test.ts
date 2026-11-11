import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteDefinition } from "../web/src/lib/site-definition.js";

describe("siteDefinition", () => {
  it("returns a plain block", () => {
    const text = 'a.test {\n\trespond "a"\n}\n\nb.test {\n\trespond "b"\n}\n';
    assert.equal(siteDefinition(text, "b.test"), 'b.test {\n\trespond "b"\n}');
  });

  it("appends an imported snippet", () => {
    const text = "(log) {\n\tlog\n}\n\na.test {\n\timport log\n}\n";
    assert.equal(siteDefinition(text, "a.test"), "a.test {\n\timport log\n}\n\n(log) {\n\tlog\n}");
  });

  it("expands nested snippets once each, in order", () => {
    const text = "(a) {\n\timport b\n}\n(b) {\n\timport a\n\tgzip\n}\nx.test {\n\timport a\n\timport b\n}\n";
    assert.equal(
      siteDefinition(text, "x.test"),
      "x.test {\n\timport a\n\timport b\n}\n\n(a) {\n\timport b\n}\n\n(b) {\n\timport a\n\tgzip\n}",
    );
  });

  it("stops expanding at depth 3", () => {
    const text = "(a) {\n\timport b\n}\n(b) {\n\timport c\n}\n(c) {\n\timport d\n}\n(d) {\n\tgzip\n}\nx.test {\n\timport a\n}\n";
    const out = siteDefinition(text, "x.test")!;
    assert.ok(out.includes("(c) {"));
    assert.ok(!out.includes("(d) {"));
  });

  it("skips a missing snippet", () => {
    const text = "x.test {\n\timport nope\n}\n";
    assert.equal(siteDefinition(text, "x.test"), "x.test {\n\timport nope\n}");
  });

  it("ignores file and glob imports", () => {
    const text = "(a.conf) {\n\tgzip\n}\nx.test {\n\timport a.conf\n\timport sites/*\n\timport ./x\n}\n";
    assert.equal(siteDefinition(text, "x.test"), "x.test {\n\timport a.conf\n\timport sites/*\n\timport ./x\n}");
  });

  it("returns null for an unknown host or empty text", () => {
    assert.equal(siteDefinition("a.test {\n}\n", "b.test"), null);
    assert.equal(siteDefinition("", "a.test"), null);
  });

  it("matches a wildcard host", () => {
    assert.equal(siteDefinition(":8080 {\n\trespond ok\n}\n", "*"), ":8080 {\n\trespond ok\n}");
  });

  it("caps the result at 60 lines", () => {
    const body = Array.from({ length: 80 }, (_, i) => `\theader X-${i} 1`).join("\n");
    const out = siteDefinition(`x.test {\n${body}\n}\n`, "x.test")!;
    const lines = out.split("\n");
    assert.equal(lines.length, 60);
    assert.equal(lines[59], "# … 23 more lines");
  });
});
