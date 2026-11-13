import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_SERVER_FILTER, isServerFiltering, serverFilterParams } from "../web/src/lib/host-log-query.js";

const NOW = 1_700_000_000_000;

describe("serverFilterParams", () => {
  it("sends nothing for no filter", () => {
    assert.equal(serverFilterParams(NO_SERVER_FILTER, NOW).toString(), "");
    assert.equal(isServerFiltering(NO_SERVER_FILTER), false);
  });

  it("sends status classes, path, client and a time range counted back from now", () => {
    const params = serverFilterParams({ classes: ["4xx", "5xx"], path: " /api ", client: "203.0.113.4", range: "1h" }, NOW);
    assert.equal(params.get("status"), "4xx,5xx");
    assert.equal(params.get("path"), "/api");
    assert.equal(params.get("client"), "203.0.113.4");
    assert.equal(params.get("from"), String(NOW - 3_600_000));
  });

  it("leaves out blank parts and the unfiltered class", () => {
    const params = serverFilterParams({ ...NO_SERVER_FILTER, classes: ["other"], path: "  " }, NOW);
    assert.equal(params.toString(), "");
  });
});
