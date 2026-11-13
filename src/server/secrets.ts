/**
 * Recognising secrets written inline in a Caddyfile: DNS provider tokens and keys, basic_auth password
 * hashes, and credential-bearing headers. One pure function over the text, returning where each secret
 * value sits. The Finding rule is built on it, and the Assistant masks secrets with the same ranges
 * before the Caddyfile leaves the machine (ADR 0008).
 *
 * It reads the text itself, not Caddy's adapted JSON, because only the text has the exact position of a
 * value. It is deliberately narrow: a value that is not clearly a secret is left alone.
 */

export type SecretKind = "dns-credential" | "password-hash" | "header-credential";

export interface Secret {
  kind: SecretKind;
  /** 1-based line the value starts on. */
  line: number;
  /** Character offsets into the text: `text.slice(from, to)` is exactly the secret value. Quotes around it are not part of it. */
  from: number;
  to: number;
  /** A name that is safe to show: the header name or the DNS provider / setting. Never the value. */
  label?: string;
}

interface Token {
  /** The raw text of the token; for a quoted token, what is between the quotes. */
  text: string;
  from: number;
  to: number;
  line: number;
  quoted: boolean;
}

/** Splits the text into logical lines of tokens: comments dropped, `\` continuations joined, heredoc bodies skipped. */
function logicalLines(text: string): Token[][] {
  const lines: Token[][] = [];
  let current: Token[] = [];
  let continued = false;
  let heredoc: string | null = null;
  let line = 1;
  let i = 0;
  const flush = () => {
    if (current.length > 0) lines.push(current);
    current = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") {
      if (!continued) flush();
      continued = false;
      line++;
      i++;
      if (heredoc !== null) {
        // Skip the body up to and including the line that is the marker.
        while (i < text.length) {
          let end = text.indexOf("\n", i);
          if (end === -1) end = text.length;
          const body = text.slice(i, end).trim();
          i = Math.min(end + 1, text.length);
          line++;
          if (body === heredoc) break;
        }
        heredoc = null;
      }
    } else if (/\s/.test(ch)) {
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === '"' || ch === "`") {
      const from = i + 1;
      i++;
      while (i < text.length && text[i] !== ch) i += ch === '"' && text[i] === "\\" ? 2 : 1;
      const to = Math.min(i, text.length);
      i = Math.min(i + 1, text.length);
      current.push({ text: text.slice(from, to), from, to, line, quoted: true });
    } else {
      const from = i;
      while (i < text.length && !/\s/.test(text[i]!)) i++;
      const word = text.slice(from, i);
      if (word === "\\") {
        continued = true;
        continue;
      }
      const marker = /^<<([A-Za-z_]\w*)$/.exec(word);
      if (marker) heredoc = marker[1]!;
      current.push({ text: word, from, to: i, line, quoted: false });
    }
  }
  flush();
  return lines;
}

const isOpen = (t: Token | undefined) => t !== undefined && !t.quoted && t.text === "{";
const isClose = (t: Token) => !t.quoted && t.text === "}";
/** Any placeholder (`{env.X}`, `{$X}`, `{file.X}`, `{http...}`) means the value is not written inline. */
const hasPlaceholder = (value: string) => /\{[^{}\s]+\}/.test(value);

const HEADER_DIRECTIVES = new Set(["header", "header_up", "header_down", "request_header"]);
const DNS_DIRECTIVES = new Set(["dns", "acme_dns"]);
const BASIC_AUTH_DIRECTIVES = new Set(["basic_auth", "basicauth"]);

/** Header names that always carry a credential, plus any name with key, token or secret in it. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);
/** Names that match "key" but are handshake values, not credentials. */
const NOT_CREDENTIAL_HEADERS = new Set(["sec-websocket-key"]);

function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (NOT_CREDENTIAL_HEADERS.has(n)) return false;
  return CREDENTIAL_HEADERS.has(n) || /key|token|secret/.test(n);
}

/** Setting names inside a DNS provider block that hold a secret. Identifiers (`access_key_id`, `zone_id`) are not. */
function isSecretSetting(name: string): boolean {
  const n = name.toLowerCase();
  if (/(^|[_-])id$/.test(n) || /(url|type|name)$/.test(n)) return false;
  return /token|key|secret|password|credential/.test(n);
}

function stripHeaderOp(name: string): string {
  return name.replace(/^[+\-?>]/, "");
}

const isMatcher = (t: Token) => !t.quoted && /^(@|\/|\*)/.test(t.text);

/**
 * Splits a logical line at every inline brace, so `dns x { api_token v }` reads as the three lines it would be if
 * written out. Caddy itself wants the braces on their own lines, but a Caddyfile that does not pass still gets sent to
 * the Assistant, and its secrets must be masked all the same.
 */
function splitInline(tokens: Token[]): Token[][] {
  const chunks: Token[][] = [];
  let current: Token[] = [];
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (isClose(token)) flush();
    current.push(token);
    if (isOpen(token)) flush();
  }
  flush();
  return chunks;
}

/** The recognised secrets in a Caddyfile, in text order. Placeholders and usernames are never returned. */
export function findSecrets(text: string): Secret[] {
  const secrets: Secret[] = [];
  /** First word of each open block's opening line, lowercased. */
  const stack: string[] = [];

  const add = (kind: SecretKind, token: Token | undefined, label?: string) => {
    if (!token || isOpen(token) || isClose(token)) return;
    if (token.text === "" || hasPlaceholder(token.text)) return;
    secrets.push({ kind, line: token.line, from: token.from, to: token.to, ...(label !== undefined && { label }) });
  };

  /** A header line's name and value: `Name value`, with the name's operator prefix stripped. A removal has no value. */
  const headerLine = (name: Token | undefined, value: Token | undefined) => {
    if (!name || !value || isOpen(value)) return;
    if (!name.quoted && /^-/.test(name.text)) return;
    const bare = stripHeaderOp(name.text);
    if (isCredentialHeader(bare)) add("header-credential", value, bare);
  };

  for (let tokens of logicalLines(text).flatMap(splitInline)) {
    while (tokens.length > 0 && isClose(tokens[0]!)) {
      stack.pop();
      tokens = tokens.slice(1);
    }
    if (tokens.length === 0) continue;
    const opens = isOpen(tokens[tokens.length - 1]);
    const head = tokens[0]!.text.toLowerCase();
    const parent = stack[stack.length - 1];
    const args = (opens ? tokens.slice(0, -1) : tokens).slice(1);

    if (HEADER_DIRECTIVES.has(head) && !tokens[0]!.quoted) {
      const rest = args.length > 0 && isMatcher(args[0]!) ? args.slice(1) : args;
      headerLine(rest[0], rest[1]);
    } else if (DNS_DIRECTIVES.has(head) && !tokens[0]!.quoted) {
      // `dns <provider> <token>`: everything after the provider name is configuration for it.
      const provider = args[0]?.text;
      for (const arg of args.slice(1)) add("dns-credential", arg, provider);
    } else if (parent !== undefined && DNS_DIRECTIVES.has(parent)) {
      // `name value` pairs; several can share a line when the block is written on one.
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        if (isSecretSetting(tokens[i]!.text)) add("dns-credential", tokens[i + 1], tokens[i]!.text);
      }
    } else if (parent !== undefined && BASIC_AUTH_DIRECTIVES.has(parent)) {
      // `username hash`: the username is not a secret.
      if (!opens) add("password-hash", tokens[1]);
    } else if (parent !== undefined && HEADER_DIRECTIVES.has(parent)) {
      if (!opens) headerLine(tokens[0], tokens[1]);
    }

    if (opens) stack.push(tokens[0]!.quoted ? "" : head);
  }
  return secrets;
}
