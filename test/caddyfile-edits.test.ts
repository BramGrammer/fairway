import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, EDIT_TOOL, parseEdits } from "../src/server/caddyfile-edits.js";

const TEXT = "a.test {\n\treverse_proxy app:1\n}\n\nb.test {\n\treverse_proxy app:2\n}\n";

test("an edit replaces text that occurs once, in order", () => {
  const result = applyEdits(TEXT, [
    { oldText: "app:1", newText: "app:10" },
    { oldText: "app:10\n}", newText: "app:10\n\tencode gzip\n}" },
  ]);
  assert.deepEqual(result, { ok: true, text: TEXT.replace("app:1\n}", "app:10\n\tencode gzip\n}") });
});

test("an edit that finds nothing, or more than one place, is reported and nothing of the call applies", () => {
  const none = applyEdits(TEXT, [{ oldText: "app:1", newText: "x" }, { oldText: "nope", newText: "y" }]);
  assert.equal(none.ok, false);
  assert.match((none as { error: string }).error, /Edit 2 .*not found/);
  const many = applyEdits(TEXT, [{ oldText: "reverse_proxy", newText: "x" }]);
  assert.equal(many.ok, false);
  assert.match((many as { error: string }).error, /Edit 1 .*occurs 2 times/);
});

test("an empty old_text appends, with a blank line between Sites, and works on an empty buffer", () => {
  const site = "c.test {\n\trespond ok\n}";
  assert.deepEqual(applyEdits(TEXT, [{ oldText: "", newText: site }]), { ok: true, text: `${TEXT}\n${site}\n` });
  assert.deepEqual(applyEdits("", [{ oldText: "", newText: site }]), { ok: true, text: site });
  assert.equal(applyEdits("x", [{ oldText: "", newText: "" }]).ok, false);
  assert.equal(applyEdits("", [{ oldText: "x", newText: "y" }]).ok, false);
});

test("arguments are read and checked", () => {
  assert.deepEqual(parseEdits('{"edits":[{"old_text":"a","new_text":"b"}]}'), { ok: true, edits: [{ oldText: "a", newText: "b" }] });
  for (const bad of ["not json", "{}", '{"edits":[]}', '{"edits":[{"old_text":"a"}]}']) assert.equal(parseEdits(bad).ok, false);
});

test("the tool has the shape of the edit list", () => {
  assert.equal(EDIT_TOOL.name, "edit_caddyfile");
  assert.deepEqual((EDIT_TOOL.parameters as { required: string[] }).required, ["edits"]);
});
