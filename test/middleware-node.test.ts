import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeStep, fitBadges, stepHeight } from "../web/src/lib/middleware-node.js";

describe("describeStep", () => {
  it("capitalises the title and lists countries from the detail", () => {
    const info = describeStep({ label: "geo: NL BE DE FR GB IE +3", detail: "Only these countries are allowed: NL, BE, DE, FR, GB, IE, LU, AT, CH" });
    assert.equal(info.title, "Geo");
    assert.deepEqual(info.items, ["NL", "BE", "DE", "FR", "GB", "IE", "LU", "AT", "CH"]);
  });

  it("keeps a qualifier in the title", () => {
    assert.equal(describeStep({ label: "geo (CDN): NL BE" }).title, "Geo (CDN)");
    assert.deepEqual(describeStep({ label: "geo (CDN): NL BE +2" }).items, ["NL", "BE"]);
  });

  it("lists encodings and header names", () => {
    assert.deepEqual(describeStep({ label: "compression", detail: "br, gzip, zstd" }).items, ["br", "gzip", "zstd"]);
  });

  it("shows a sentence as a note instead of badges", () => {
    const info = describeStep({ label: "WAF", detail: "Coraza web application firewall" });
    assert.equal(info.title, "WAF");
    assert.deepEqual(info.items, []);
    assert.equal(info.note, "Coraza web application firewall");
  });

  it("has nothing under a bare title", () => {
    assert.deepEqual(describeStep({ label: "cache" }), { title: "Cache", items: [] });
  });
});

describe("fitBadges", () => {
  it("shows what fits and counts the rest", () => {
    const result = fitBadges(["NL", "BE", "DE", "FR", "GB", "IE", "LU", "AT", "CH"], 120);
    assert.ok(result.shown.length > 0 && result.shown.length < 9);
    assert.equal(result.shown.length + result.hidden, 9);
  });

  it("shows everything when there is room", () => {
    assert.deepEqual(fitBadges(["br", "gzip"], 200), { shown: ["br", "gzip"], hidden: 0 });
  });

  it("never reports more badges than there are items", () => {
    assert.equal(fitBadges(["NL"], 5).hidden, 1);
  });
});

describe("stepHeight", () => {
  it("is taller when there is a second row", () => {
    assert.ok(stepHeight({ label: "geo: NL", detail: "NL" }) > stepHeight({ label: "cache" }));
  });
});
