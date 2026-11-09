import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expandedDetails, filterLines, statusClass, type StatusClass } from "../web/src/lib/host-log-filter.js";
import type { HostLogLine } from "../web/src/lib/api.js";

const line = (over: Partial<HostLogLine> = {}): HostLogLine => ({
  time: 0, status: 200, method: "GET", host: "app.example.test", uri: "/a", client: "203.0.113.9",
  duration: 0.5, size: 10, userAgent: "", raw: {}, ...over,
});

describe("statusClass", () => {
  it("groups codes", () => {
    assert.equal(statusClass(204), "2xx");
    assert.equal(statusClass(301), "3xx");
    assert.equal(statusClass(404), "4xx");
    assert.equal(statusClass(502), "5xx");
    assert.equal(statusClass(101), "other");
    assert.equal(statusClass(null), "other");
  });
});

describe("filterLines", () => {
  const lines = [
    line({ status: 200, uri: "/Home" }),
    line({ status: 404, uri: "/missing", client: "198.51.100.7" }),
    line({ status: 500, uri: "/api", userAgent: "Curl/8.0" }),
  ];
  const none = new Set<StatusClass>();
  it("keeps everything with no classes and a blank query", () => {
    assert.equal(filterLines(lines, { classes: none, query: "  " }).length, 3);
  });
  it("filters by status class", () => {
    const out = filterLines(lines, { classes: new Set<StatusClass>(["4xx", "5xx"]), query: "" });
    assert.deepEqual(out.map((l) => l.status), [404, 500]);
  });
  it("matches uri, client and user agent ignoring case and padding", () => {
    assert.deepEqual(filterLines(lines, { classes: none, query: " HOME " }).map((l) => l.uri), ["/Home"]);
    assert.deepEqual(filterLines(lines, { classes: none, query: "198.51" }).map((l) => l.uri), ["/missing"]);
    assert.deepEqual(filterLines(lines, { classes: none, query: "curl" }).map((l) => l.uri), ["/api"]);
  });
  it("combines class and query", () => {
    assert.equal(filterLines(lines, { classes: new Set<StatusClass>(["2xx"]), query: "api" }).length, 0);
  });
});

describe("expandedDetails", () => {
  it("lists details in order from the raw entry", () => {
    const details = expandedDetails(line({
      userAgent: "Agent/1",
      raw: {
        duration: 0.25, size: 99,
        request: {
          method: "POST", host: "app.example.test", uri: "/x", proto: "HTTP/2.0",
          headers: { Accept: ["a", "b"], "User-Agent": ["Agent/1"] },
          tls: { version: 772, cipher_suite: 4865, server_name: "app.example.test" },
        },
        resp_headers: { "Content-Type": ["text/html"] },
      },
    }));
    assert.deepEqual(details.map((d) => d.label), [
      "Method", "Host", "URI", "User agent", "Protocol", "TLS version", "TLS cipher suite", "TLS server name",
      "Request header Accept", "Request header User-Agent", "Response header Content-Type", "Duration", "Size",
    ]);
    assert.equal(details.find((d) => d.label === "Request header Accept")?.value, "a, b");
    assert.equal(details.find((d) => d.label === "TLS version")?.value, "TLS 1.3");
    assert.equal(details.at(-2)?.value, "0.25 s");
  });
  it("tolerates missing and malformed fields", () => {
    const details = expandedDetails(line({ duration: null, size: null, raw: { request: "nope", resp_headers: [1] } }));
    assert.deepEqual(details.map((d) => d.label), ["Method", "Host", "URI"]);
  });
  it("falls back to the User-Agent header", () => {
    const details = expandedDetails(line({ raw: { request: { headers: { "user-agent": ["Z/2"] } } } }));
    assert.equal(details.find((d) => d.label === "User agent")?.value, "Z/2");
  });
});
