import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRules } from "../src/server/rules.js";
import { findSecrets } from "../src/server/secrets.js";

/** The text of every recognised secret, so a test reads as "these values were found". */
const values = (text: string) => findSecrets(text).map((s) => text.slice(s.from, s.to));

describe("findSecrets: DNS providers", () => {
  it("finds a token given inline after the provider", () => {
    const text = "a.test {\n\ttls {\n\t\tdns cloudflare fake-token-123\n\t}\n}\n";
    const [s] = findSecrets(text);
    assert.equal(text.slice(s!.from, s!.to), "fake-token-123");
    assert.equal(s!.kind, "dns-credential");
    assert.equal(s!.line, 3);
    assert.equal(s!.label, "cloudflare");
  });

  it("finds acme_dns in global options and in an issuer", () => {
    assert.deepEqual(values("{\n\tacme_dns duckdns fake-a\n}\n"), ["fake-a"]);
    assert.deepEqual(values("a.test {\n\ttls {\n\t\tissuer acme {\n\t\t\tdns hetzner fake-b\n\t\t}\n\t}\n}\n"), ["fake-b"]);
  });

  it("finds secret settings in a provider block but not identifiers", () => {
    const text = "{\n\tacme_dns route53 {\n\t\taccess_key_id fake-id\n\t\tsecret_access_key fake-secret\n\t\tregion eu-west-1\n\t\tapi_url https://x.test\n\t}\n}\n";
    assert.deepEqual(values(text), ["fake-secret"]);
  });

  it("covers only the inside of quotes", () => {
    const text = 'a.test {\n\ttls {\n\t\tdns cloudflare "fake token"\n\t}\n}\n';
    assert.deepEqual(values(text), ["fake token"]);
  });

  it("ignores placeholders and a bare provider", () => {
    assert.deepEqual(values("a.test {\n\ttls {\n\t\tdns cloudflare {env.CF_TOKEN}\n\t}\n}\n"), []);
    assert.deepEqual(values("a.test {\n\ttls {\n\t\tdns cloudflare {$CF_TOKEN}\n\t\tdns x {file.tok}\n\t}\n}\n"), []);
    assert.deepEqual(values("{\n\tacme_dns route53 {\n\t\tsecret_access_key {env.AWS}\n\t}\n}\n"), []);
    assert.deepEqual(values("a.test {\n\ttls {\n\t\tdns route53\n\t}\n}\n"), []);
  });
});

describe("findSecrets: basic_auth", () => {
  it("finds the hash and not the username, for basic_auth and basicauth", () => {
    const text = "a.test {\n\tbasic_auth /admin/* {\n\t\talice $2a$14$fakefakefakefake\n\t\tbob $2a$14$otherfake\n\t}\n\tbasicauth {\n\t\tcarol fakehash\n\t}\n}\n";
    const found = findSecrets(text);
    assert.deepEqual(found.map((s) => text.slice(s.from, s.to)), ["$2a$14$fakefakefakefake", "$2a$14$otherfake", "fakehash"]);
    assert.deepEqual(found.map((s) => s.line), [3, 4, 7]);
    assert.ok(found.every((s) => s.kind === "password-hash"));
  });

  it("ignores a hash given as a placeholder", () => {
    assert.deepEqual(values("a.test {\n\tbasic_auth {\n\t\talice {env.ALICE_HASH}\n\t}\n}\n"), []);
  });
});

describe("findSecrets: blocks written on one line", () => {
  it("finds a DNS setting and a hash inside braces on the same line", () => {
    const dns = "{\n\tacme_dns cloudflare { api_token fake-token zone_id fake-zone }\n}\n";
    assert.deepEqual(values(dns), ["fake-token"]);
    assert.deepEqual(values("a.test {\n\ttls {\n\t\tdns provider { api_token fake-one }\n\t}\n}\n"), ["fake-one"]);
    assert.deepEqual(values("a.test {\n\tbasic_auth { alice fakehash }\n}\n"), ["fakehash"]);
    assert.deepEqual(values("a.test {\n\theader { Authorization \"Bearer fake-bearer\" }\n}\n"), ["Bearer fake-bearer"]);
  });

  it("still pairs up several settings on one line and keeps later lines in the right block", () => {
    const text = "a.test {\n\tdns x { api_token one secret_key two }\n\trespond ok\n}\n";
    assert.deepEqual(values(text), ["one", "two"]);
    assert.deepEqual(values("a.test {\n\tbasic_auth { alice fakehash }\n\theader X-Api-Key fake-key\n}\n"), ["fakehash", "fake-key"]);
  });

  it("does not treat the old one-line basicauth form as credentials, which Caddy 2 does not read that way", () => {
    assert.deepEqual(values("a.test {\n\tbasicauth /admin alice fakehash\n}\n"), []);
  });
});

describe("findSecrets: headers", () => {
  it("finds credential headers in every header directive", () => {
    const text = [
      "a.test {",
      "\theader X-Api-Key fake-key",
      "\treverse_proxy app:80 {",
      '\t\theader_up Authorization "Bearer fake-bearer"',
      "\t\theader_down +X-Secret fake-s",
      "\t}",
      "\trequest_header Cookie session=fake",
      "\theader_up @api Proxy-Authorization fake-proxy",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(values(text), ["fake-key", "Bearer fake-bearer", "fake-s", "session=fake", "fake-proxy"]);
    assert.equal(findSecrets(text)[1]!.label, "Authorization");
  });

  it("finds credentials inside a header block", () => {
    const text = "a.test {\n\theader {\n\t\tX-Auth-Token fake-t\n\t\t-Authorization\n\t\tX-Frame-Options DENY\n\t}\n}\n";
    assert.deepEqual(values(text), ["fake-t"]);
  });

  it("ignores placeholders, ordinary headers and removals", () => {
    const text = [
      "a.test {",
      "\theader_up Authorization {env.UPSTREAM_AUTH}",
      '\theader_up Authorization "Bearer {env.TOKEN}"',
      "\theader_up X-Api-Key {$KEY}",
      "\theader_up Cookie {http.request.header.Cookie}",
      "\theader_up Host example.test",
      "\theader_up Sec-WebSocket-Key abc",
      "\theader -Authorization",
      "\theader_up -X-Api-Key",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(values(text), []);
  });
});

describe("findSecrets: structure", () => {
  it("finds secrets inside snippets and nested blocks", () => {
    const text =
      "(auth) {\n\tbasic_auth {\n\t\tdave fake-snippet-hash\n\t}\n}\na.test {\n\timport auth\n\thandle /x {\n\t\treverse_proxy app:80 {\n\t\t\theader_up X-Token fake-nested\n\t\t}\n\t}\n}\n";
    const found = findSecrets(text);
    assert.deepEqual(found.map((s) => text.slice(s.from, s.to)), ["fake-snippet-hash", "fake-nested"]);
    assert.deepEqual(found.map((s) => s.line), [3, 10]);
  });

  it("ignores comments, heredoc bodies and names outside their directive", () => {
    const text = "# header X-Api-Key fake\na.test {\n\trespond <<EOT\n\t\theader X-Api-Key fake\n\tEOT 200\n\tdns cloudflare\n}\n";
    assert.deepEqual(values(text), []);
  });

  it("follows backslash continuations to the right line", () => {
    const text = "a.test {\n\theader_up X-Api-Key \\\n\t\tfake-k\n}\n";
    const [s] = findSecrets(text);
    assert.equal(text.slice(s!.from, s!.to), "fake-k");
    assert.equal(s!.line, 3);
  });

  it("gives no secrets for an empty text", () => {
    assert.deepEqual(findSecrets(""), []);
  });
});

describe("rule: secret written inline", () => {
  const text =
    'a.test {\n\treverse_proxy app:80 {\n\t\theader_up Authorization "Bearer fake-bearer"\n\t}\n\ttls {\n\t\tdns cloudflare fake-token-123\n\t}\n\tbasic_auth {\n\t\talice fakehashvalue\n\t}\n}\n';
  const findings = runRules({}, text);

  it("gives a warning at the line of each secret, pointing at {env.X}", () => {
    assert.deepEqual(findings.map((f) => [f.level, f.origin, f.line]), [["warning", "rules", 3], ["warning", "rules", 6], ["warning", "rules", 9]]);
    for (const f of findings) assert.match(f.message, /\{env\.NAME\}/);
  });

  it("never puts the secret in the message", () => {
    for (const f of findings) for (const secret of ["fake-bearer", "fake-token-123", "fakehashvalue"]) assert.ok(!f.message.includes(secret));
  });

  it("is quiet when everything is a placeholder", () => {
    assert.deepEqual(runRules({}, "a.test {\n\theader_up Authorization {env.A}\n\ttls {\n\t\tdns cloudflare {env.T}\n\t}\n}\n"), []);
  });
});
