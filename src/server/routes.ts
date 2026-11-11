/** A readable overview of Caddy's route JSON: which hosts go where, and what applies on the way. */

export interface Chip {
  label: string;
  detail?: string;
}

export interface Destination {
  kind: "proxy" | "file" | "redirect" | "respond" | "other";
  summary: string;
  /** Proxy upstream addresses, with an https:// prefix when Caddy talks TLS to them. */
  upstreams?: string[];
  status?: number;
  target?: string;
}

export interface Rule {
  /** Empty means every request that no other rule of the site caught. */
  match: string;
  destinations: Destination[];
  /** Middleware that applies to this rule on top of the site-wide chips. */
  middleware: Chip[];
  /** The rule's own match as short chips (one per matcher); long ones carry the full text as detail. */
  matchers: Chip[];
}

export interface Site {
  hosts: string[];
  listen: string[];
  middleware: Chip[];
  rules: Rule[];
}

type Json = Record<string, unknown>;
type Matcher = Record<string, unknown>;

interface Route {
  match?: Matcher[];
  handle?: Json[];
}

interface Server {
  listen?: string[];
  routes?: Route[];
}

type Item =
  | { ctx: string[]; chips: Chip[]; kind: "middleware"; chip: Chip }
  | { ctx: string[]; chips: Chip[]; kind: "terminal"; dest: Destination };

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];

function describeMatcher(key: string, value: unknown): string {
  const v = value as Json;
  switch (key) {
    case "path":
      return `path ${stringList(value).join(" ")}`;
    case "path_regexp":
      return `path ~ ${String(v.pattern ?? "")}`;
    case "method":
      return `method ${stringList(value).join("|")}`;
    case "header":
      return Object.entries(v)
        .map(([name, values]) => `${name}: ${stringList(values).join("|")}`)
        .join(", ");
    case "header_regexp":
      return Object.entries(v)
        .map(([name, matcher]) => `${name} ~ ${String((matcher as Json).pattern ?? "")}`)
        .join(", ");
    case "vars":
      return Object.entries(v)
        .map(([name, values]) => `${name.replace(/[{}]/g, "")} = ${stringList(values).join("|")}`)
        .join(", ");
    case "remote_ip":
      return `ip ${stringList(v.ranges).join(" ")}`;
    case "protocol":
      return `protocol ${String(value)}`;
    case "query":
      return `query ${Object.entries(v).map(([name, values]) => `${name}=${stringList(values).join("|")}`).join("&")}`;
    case "expression":
      return `expr ${String((v.expr as string | undefined) ?? value)}`;
    case "not":
      return `not (${describeSets(value as Matcher[])})`;
    default:
      return key;
  }
}

function describeSet(set: Matcher): string {
  return Object.entries(set).map(([key, value]) => describeMatcher(key, value)).join(" and ");
}

function describeSets(sets: Matcher[] | undefined): string {
  return (sets ?? []).map(describeSet).filter(Boolean).join(" or ");
}

/** One readable piece of a matcher: its text, plus the values behind it when it is a list. */
interface Part {
  text: string;
  /** What the part is, used in the short label of a long one, e.g. `ip` or `header X-Forwarded-For`. */
  noun: string;
  /** Singular unit of the values, e.g. `range`. */
  unit: string;
  values: string[];
  negated?: boolean;
}

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;

function listPart(noun: string, unit: string, values: string[], text: string): Part {
  return { text, noun, unit, values };
}

function matcherParts(key: string, value: unknown): Part[] {
  const v = value as Json;
  switch (key) {
    case "path": {
      const values = stringList(value);
      return [listPart("path", "path", values, `path ${values.join(" ")}`)];
    }
    case "method": {
      const values = stringList(value);
      return [listPart("method", "method", values, `method ${values.join("|")}`)];
    }
    case "remote_ip": {
      const values = stringList(v.ranges);
      return [listPart("ip", "range", values, `ip ${values.join(" ")}`)];
    }
    case "header":
      return Object.entries(v).map(([name, values]) => {
        const list = stringList(values);
        return listPart(`header ${name}`, "value", list, `${name}: ${list.join("|")}`);
      });
    case "vars":
      return Object.entries(v).map(([name, values]) => {
        const list = stringList(values);
        const clean = name.replace(/[{}]/g, "");
        return listPart(`var ${clean}`, "value", list, `${clean} = ${list.join("|")}`);
      });
    case "header_regexp":
      return Object.entries(v).map(([name, matcher]) => {
        const text = `${name} ~ ${String((matcher as Json).pattern ?? "")}`;
        return listPart(`header ${name}`, "pattern", [text], text);
      });
    case "not": {
      const sets = value as Matcher[];
      const inner = sets.length === 1 ? Object.entries(sets[0]).flatMap(([k, val]) => matcherParts(k, val)) : [];
      if (inner.length === 1) return [{ ...inner[0], negated: !inner[0].negated, text: inner[0].negated ? inner[0].text.replace(/^not /, "") : `not ${inner[0].text}` }];
      const text = describeMatcher(key, value);
      return [listPart("not", "condition", [text], text)];
    }
    default: {
      const text = describeMatcher(key, value);
      return [listPart(key, "value", [text], text)];
    }
  }
}

const LONG_TEXT = 32;
const LONG_VALUES = 3;

/** Short parts keep their text; long ones get a summary label and the whole text as detail. */
function partChip(part: Part): Chip {
  const { text, values, negated } = part;
  const multi = values.length > 1;
  if (!(values.length > LONG_VALUES || text.length > LONG_TEXT)) return { label: text };
  const prefix = negated ? "not " : "";
  if (!multi) return { label: `${text.slice(0, LONG_TEXT - 3)}...`, detail: text };
  // Detail: a heading line (the noun, with "not " when negated) and then one value per line.
  return { label: `${prefix}${part.noun} · ${plural(values.length, part.unit)}`, detail: [`${prefix}${part.noun}`, ...values].join("\n") };
}

/** The chips for one nesting level: one per matcher in a set, or a single "a or b" chip for several sets. */
function describeChips(sets: Matcher[] | undefined): Chip[] {
  const filled = (sets ?? []).filter((set) => Object.keys(set).length > 0);
  if (filled.length === 0) return [];
  if (filled.length === 1) return Object.entries(filled[0]).flatMap(([k, v]) => matcherParts(k, v).map(partChip));
  const lines = filled.map(describeSet).filter(Boolean);
  const label = lines.join(" or ");
  return label.length > LONG_TEXT
    ? [{ label: `${plural(lines.length, "alternative")}`, detail: lines.join("\nor ") }]
    : [{ label }];
}

/** Pulls the host names out of a route's matchers and returns what is left. */
function extractHosts(match: Matcher[] | undefined): { hosts: string[]; rest: Matcher[] } {
  const hosts: string[] = [];
  const rest: Matcher[] = [];
  for (const set of match ?? []) {
    const { host, ...others } = set;
    hosts.push(...stringList(host));
    if (Object.keys(others).length > 0) rest.push(others);
  }
  return { hosts, rest };
}

/** A matcher that is just `not (...)`, used by Caddyfile snippets that block requests. */
function pureNot(match: Matcher[] | undefined): Matcher[] | null {
  if (match?.length !== 1) return null;
  const keys = Object.keys(match[0]);
  return keys.length === 1 && keys[0] === "not" ? (match[0].not as Matcher[]) : null;
}

const isBlock = (handler: Json) => handler.handler === "static_response" && Number(handler.status_code) === 403;

function countryChip(label: string, countries: string[]): Chip {
  const shown = countries.slice(0, 6).join(" ");
  const more = countries.length > 6 ? ` +${countries.length - 6}` : "";
  return { label: `${label}: ${shown}${more}`, detail: `Only these countries are allowed: ${countries.join(", ")}` };
}

/** Turns "block unless X" into a chip that says what is allowed. */
function restrictionChip(inner: Matcher[]): Chip {
  for (const set of inner) {
    const vars = set.vars as Record<string, unknown> | undefined;
    for (const [name, values] of Object.entries(vars ?? {})) {
      if (/country/i.test(name)) return countryChip("geo", stringList(values));
    }
    const headers = set.header_regexp as Record<string, { pattern?: string }> | undefined;
    for (const [name, matcher] of Object.entries(headers ?? {})) {
      if (/country/i.test(name)) {
        const group = /\(([A-Z|]+)\)/.exec(matcher.pattern ?? "");
        if (group) return countryChip("geo (CDN)", group[1].split("|"));
      }
    }
  }
  return { label: "restricted", detail: `Allowed only if ${describeSets(inner)}` };
}

const KNOWN_MIDDLEWARE: Record<string, (handler: Json) => Chip> = {
  encode: (h) => ({ label: "compression", detail: Object.keys((h.encodings as Json | undefined) ?? {}).join(", ") }),
  headers: (h) => {
    const names = [
      ...Object.keys(((h.response as Json | undefined)?.set as Json | undefined) ?? {}),
      ...Object.keys(((h.request as Json | undefined)?.set as Json | undefined) ?? {}),
    ];
    return { label: "headers", detail: names.join(", ") || undefined };
  },
  // The Coraza module registers itself as "waf" in the JSON config.
  waf: () => ({ label: "WAF", detail: "Coraza web application firewall" }),
  coraza_waf: () => ({ label: "WAF", detail: "Coraza web application firewall" }),
  cache: () => ({ label: "cache" }),
  rate_limit: () => ({ label: "rate limit" }),
  authentication: () => ({ label: "auth" }),
  rewrite: (h) => ({ label: "rewrite", detail: String(h.uri ?? "") || undefined }),
  request_body: () => ({ label: "body limit" }),
};

/** Handlers that only set up state for others, so they are not worth showing. */
const HIDDEN = new Set(["vars", "geo_ip", "geoip"]);

/**
 * `root` comes from a `vars` handler that can sit in an earlier route than the file_server it
 * configures (a matcher in between splits the chain), so it carries across sibling routes.
 */
function walk(routes: Route[], ctx: string[], chips: Chip[], items: Item[], inheritedRoot?: string): void {
  let sharedRoot = inheritedRoot;
  for (const route of routes) {
    const handlers = route.handle ?? [];
    const guard = handlers.length > 0 && handlers.every(isBlock) ? pureNot(route.match) : null;
    const local = guard ? null : describeSets(route.match);
    const here = local ? [...ctx, local] : ctx;
    const hereChips = local ? [...chips, ...describeChips(route.match)] : chips;
    let root = sharedRoot;

    for (const handler of handlers) {
      const name = String(handler.handler);
      if (name === "subroute") {
        walk((handler.routes as Route[] | undefined) ?? [], here, hereChips, items, root);
      } else if (name === "reverse_proxy") {
        const tls = Boolean((handler.transport as Json | undefined)?.tls);
        const upstreams = ((handler.upstreams as Json[] | undefined) ?? []).map(
          (upstream) => `${tls ? "https://" : ""}${String(upstream.dial ?? upstream.lookup_srv ?? "?")}`,
        );
        items.push({ ctx: here, chips: hereChips, kind: "terminal", dest: { kind: "proxy", summary: `proxy to ${upstreams.join(", ")}`, upstreams } });
      } else if (name === "file_server") {
        const dir = root ?? String(handler.root ?? ".");
        const browse = handler.browse ? " (browsable)" : "";
        items.push({ ctx: here, chips: hereChips, kind: "terminal", dest: { kind: "file", summary: `files from ${dir}${browse}` } });
      } else if (name === "static_response") {
        const status = handler.status_code === undefined ? undefined : Number(handler.status_code);
        const location = stringList((handler.headers as Json | undefined)?.Location)[0];
        if (guard && isBlock(handler)) {
          items.push({ ctx: here, chips: hereChips, kind: "middleware", chip: restrictionChip(guard) });
        } else if (location) {
          items.push({
            ctx: here,
            chips: hereChips,
            kind: "terminal",
            dest: { kind: "redirect", summary: `redirect ${status ?? 302} to ${location}`, status: status ?? 302, target: location },
          });
        } else {
          const body = typeof handler.body === "string" && handler.body ? ` "${handler.body.slice(0, 40)}"` : "";
          items.push({
            ctx: here,
            chips: hereChips,
            kind: "terminal",
            dest: { kind: "respond", summary: handler.close ? "close connection" : `respond ${status ?? 200}${body}`, status },
          });
        }
      } else if (name === "vars" && typeof handler.root === "string") {
        root = handler.root;
        if (!local) sharedRoot = root;
      } else if (!HIDDEN.has(name)) {
        const chip = KNOWN_MIDDLEWARE[name]?.(handler) ?? { label: name };
        items.push({ ctx: here, chips: hereChips, kind: "middleware", chip });
      }
    }
  }
}

const isPrefix = (prefix: string[], of: string[]) =>
  prefix.length <= of.length && prefix.every((part, i) => part === of[i]);

function unique(chips: Chip[]): Chip[] {
  const seen = new Set<string>();
  return chips.filter((chip) => {
    const key = `${chip.label}|${chip.detail ?? ""}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

function summarizeRoute(route: Route, listen: string[]): Site {
  const { hosts, rest } = extractHosts(route.match);
  const items: Item[] = [];
  walk([{ match: rest, handle: route.handle }], [], [], items);

  const middleware = items.filter((item) => item.kind === "middleware");
  const siteWide = unique(middleware.filter((item) => item.ctx.length === 0).map((item) => item.chip));

  const rules = new Map<string, Rule>();
  for (const item of items) {
    if (item.kind !== "terminal") continue;
    const key = item.ctx.join(" → ");
    let rule = rules.get(key);
    if (!rule) {
      const scoped = middleware.filter((m) => m.ctx.length > 0 && isPrefix(m.ctx, item.ctx)).map((m) => m.chip);
      rule = { match: key, destinations: [], middleware: unique(scoped), matchers: item.chips };
      rules.set(key, rule);
    }
    rule.destinations.push(item.dest);
  }

  return { hosts: hosts.length > 0 ? hosts : ["*"], listen, middleware: siteWide, rules: [...rules.values()] };
}

/** Caddy's own HTTP to HTTPS redirect server is noise in an overview. */
export function isAutoRedirect(server: Server): boolean {
  const routes = server.routes ?? [];
  return (
    routes.length > 0 &&
    routes.every((route) =>
      (route.handle ?? []).every((handler) => {
        const location = stringList((handler.headers as Json | undefined)?.Location)[0] ?? "";
        return handler.handler === "static_response" && location.startsWith("https://{http.request.host}");
      }),
    )
  );
}

export function summarizeRoutes(servers: Record<string, unknown> | null | undefined): Site[] {
  const sites: Site[] = [];
  for (const server of Object.values(servers ?? {}) as Server[]) {
    if (isAutoRedirect(server)) continue;
    for (const route of server.routes ?? []) sites.push(summarizeRoute(route, server.listen ?? []));
  }
  return sites.sort((a, b) => a.hosts[0].localeCompare(b.hosts[0]));
}
