import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskCaddyfile, maskKnown, restoreSecrets } from "../src/server/masking.js";

const CADDYFILE = [
  "a.test {",
  "\treverse_proxy app:8080 {",
  "\t\theader_up Authorization fake-bearer-1",
  "\t}",
  "\tbasic_auth {",
  "\t\talice fakehash-aaa",
  "\t}",
  "}",
  "b.test {",
  "\theader X-Api-Key fake-bearer-1",
  "}",
  "",
].join("\n");

describe("masking", () => {
  it("replaces every recognised secret and leaves the rest alone", () => {
    const masked = maskCaddyfile(CADDYFILE);
    assert.ok(!masked.text.includes("fake-bearer-1"));
    assert.ok(!masked.text.includes("fakehash-aaa"));
    assert.match(masked.text, /header_up Authorization __FAIRWAY_SECRET_1__/);
    assert.match(masked.text, /alice __FAIRWAY_SECRET_2__/);
    assert.match(masked.text, /reverse_proxy app:8080/);
  });

  it("gives the same value the same placeholder and different values different ones", () => {
    const masked = maskCaddyfile(CADDYFILE);
    assert.equal(masked.secrets.length, 2);
    assert.equal(masked.text.match(/__FAIRWAY_SECRET_1__/g)?.length, 2);
    assert.deepEqual(masked.secrets.map((s) => s.value), ["fake-bearer-1", "fakehash-aaa"]);
  });

  it("is the same on every run over the same text", () => {
    assert.deepEqual(maskCaddyfile(CADDYFILE), maskCaddyfile(CADDYFILE));
  });

  it("round-trips: restoring the masked text gives the original, quotes and one-line blocks included", () => {
    const text = `${CADDYFILE}c.test {\n\theader Authorization "Bearer fake-quoted"\n\tbasic_auth { bob onelinehash }\n}\n`;
    const masked = maskCaddyfile(text);
    assert.ok(!masked.text.includes("fake-quoted") && !masked.text.includes("onelinehash"));
    assert.equal(restoreSecrets(masked, masked.text), text);
  });

  it("restores a placeholder inside text the model wrote, and leaves an unknown one", () => {
    const masked = maskCaddyfile(CADDYFILE);
    assert.equal(restoreSecrets(masked, "hash __FAIRWAY_SECRET_2__ and __FAIRWAY_SECRET_9__"), "hash fakehash-aaa and __FAIRWAY_SECRET_9__");
  });

  it("returns a text without secrets unchanged, with an empty mapping", () => {
    const masked = maskCaddyfile("a.test {\n\trespond hi\n}\n");
    assert.deepEqual(masked, { text: "a.test {\n\trespond hi\n}\n", secrets: [] });
  });

  it("masks known values in other text, but not short ones", () => {
    const masked = maskCaddyfile("a.test {\n\theader X-Api-Key abc\n\theader X-Token longer-secret-value\n}\n");
    assert.equal(maskKnown(masked, "bad value longer-secret-value near abc"), "bad value __FAIRWAY_SECRET_2__ near abc");
  });
});
