import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSiteBlocks } from "../web/src/lib/site-blocks.js";

const slice = (text: string, host: string) =>
  findSiteBlocks(text, host).map((m) => text.slice(m.from, m.to));

describe("findSiteBlocks", () => {
  it("selects the whole block of the host", () => {
    const text = 'a.example.com {\n\trespond "a"\n}\n\nb.example.com {\n\trespond "b"\n}\n';
    assert.deepEqual(slice(text, "b.example.com"), ['b.example.com {\n\trespond "b"\n}']);
  });

  it("finds a block with several hosts from any of them", () => {
    const text = "example.com, www.example.com, localhost {\n\tencode gzip\n}\n";
    for (const host of ["example.com", "www.example.com", "localhost"]) {
      assert.equal(findSiteBlocks(text, host).length, 1, host);
    }
  });

  it("finds hosts spread over lines and separated by spaces", () => {
    const text = "example.com,\nwww.example.com {\n\tencode gzip\n}\n";
    assert.equal(findSiteBlocks(text, "www.example.com").length, 1);
    assert.equal(findSiteBlocks("one.test two.test {\n}\n", "two.test").length, 1);
  });

  it("ignores scheme, port and case in the address", () => {
    const text = "https://Example.com:8443 {\n}\n";
    assert.equal(findSiteBlocks(text, "example.com").length, 1);
  });

  it("returns every match in order", () => {
    const text = "example.com:80 {\n}\nexample.com:443 {\n}\n";
    const found = findSiteBlocks(text, "example.com");
    assert.equal(found.length, 2);
    assert.ok(found[0]!.from < found[1]!.from);
  });

  it("returns nothing when no block matches", () => {
    assert.deepEqual(findSiteBlocks("a.example.com {\n}\n", "b.example.com"), []);
  });

  it("does not look inside blocks, comments or strings", () => {
    const text = [
      "# example.com {",
      "a.example.com {",
      "\treverse_proxy example.com {",
      "\t\theader_up Host example.com",
      "\t}",
      '\trespond "example.com {"',
      "}",
      "",
    ].join("\n");
    assert.deepEqual(findSiteBlocks(text, "example.com"), []);
    assert.equal(findSiteBlocks(text, "a.example.com").length, 1);
  });

  it("skips the global options block and snippets", () => {
    const text = "{\n\temail me@example.com\n}\n(common) {\n\tencode gzip\n}\nexample.com {\n}\n";
    assert.equal(findSiteBlocks(text, "example.com").length, 1);
    assert.deepEqual(findSiteBlocks(text, "common"), []);
  });

  it("matches port-only and wildcard addresses for any host", () => {
    assert.equal(findSiteBlocks(":8080 {\n}\n", "*").length, 1);
    assert.equal(findSiteBlocks("* {\n}\n", "*").length, 1);
    assert.deepEqual(findSiteBlocks("example.com {\n}\n", "*"), []);
  });

  it("handles a block that is never closed", () => {
    const text = "example.com {\n\tencode gzip\n";
    assert.deepEqual(slice(text, "example.com"), [text.trimEnd()]);
  });
});
