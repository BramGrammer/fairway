# What Fairway can show about the Caddy plugins

Research date 2026-11-10. Read-only; nothing in Fairway was changed. Everything below comes from plugin source, plugin READMEs, Caddy's source and docs, Coraza and CRS sources. Anything not checked against source is marked **unverified**. Log-line examples are **constructed from the format strings in source**, not captured from a running Caddy (nothing was built or run).

## Read this first: versions and conventions

- `dev/caddy/Dockerfile` pins no plugin version. xcaddy then takes each module's newest release tag (assumption, standard Go behaviour; confirm with `caddy build-info` in the image). Tags found with `gh api repos/<repo>/tags`: coraza-caddy v2.6.2, caddy-ratelimit **v0.1.0**, cache-handler v0.17.0, caddy-geo-ip v0.6.0, caddy-l4 v0.1.2, caddy-brotli v1.7.0, caddy-dns/cloudflare v0.2.4, certmagic-s3 has no tag (HEAD).
- Version traps that change the answers:
  - **caddy-ratelimit v0.1.0 has no Prometheus metrics.** `metrics.go` returns 404 at that tag and exists on master (7 commits ahead). So with the unpinned Dockerfile the `caddy_rate_limit_*` series below probably do not exist. Pin `@master` or a commit to get them.
  - **coraza-caddy v2.6.2 logs fewer fields than main.** `rule_id` and `action` on the violation line, and "interruption triggered by rule N (deny)" as the error text, are in main only (commits after v2.6.2, PR #361). v2.6.2 embeds CRS v4.25.0, main embeds v4.30.0.
- Every plugin logger is named after its module ID, because `caddy.Context.Logger(mod)` calls `.Named(modID)` ([caddy logging.go `Logging.Logger`, v2.11.9](https://github.com/caddyserver/caddy/blob/v2.11.9/logging.go)). Entries are Caddy zap JSON: `level`, `ts`, `logger`, `msg`, plus fields ([Caddy logging docs](https://caddyserver.com/docs/logging)).
- Default Caddy log level is INFO, so anything the plugins log at DEBUG is invisible unless the owner raises it ([coraza-caddy TROUBLESHOOTING.md](https://github.com/corazawaf/coraza-caddy/blob/5d6d37ab2162f09ae4e3fd6c3d6bca45747910ad/TROUBLESHOOTING.md), "Debug log file ... stays empty"). A log with no include/exclude takes every logger ([caddy logging.go `loggerAllowed`](https://github.com/caddyserver/caddy/blob/v2.11.9/logging.go)), so in `dev/Caddyfile.sample` the global `log` to `access.log` already receives plugin lines. A per-host `log` block normally narrows itself to its own `http.log.access.<name>` (not checked in the adapter source).
- Handler errors below 500 are logged by Caddy at **DEBUG** (`Server.ServeHTTP` in [modules/caddyhttp/server.go L779](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddyhttp/server.go)). A WAF 403 or a rate-limit 429 therefore does not appear in `http.log.error` by default. The access log still records the status and `resp_headers` (`logRequest`, same file L1244-1320).
- Caddy's admin `GET /config/[path]` returns the running JSON ([API docs](https://caddyserver.com/docs/api#get-configpath)). There is no admin endpoint listing modules or versions.
- Per-host Prometheus labels: in Caddy v2.11.9 (the version read) the `handler` label is the module name of the **first** handler of the route (`handlerName` in [routes.go](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddyhttp/routes.go), `metrics.go` L300-410). Do not use it to attribute traffic to a plugin. With `per_host`, hosts not named in a host matcher fold into `_other` on HTTP servers ([metrics docs](https://caddyserver.com/docs/metrics), `Metrics` struct comment).

## Summary

| Plugin | Config visible (`/config`) | Metrics | Logs | Verdict |
|---|---|---|---|---|
| WAF (coraza-caddy) | Yes: handler `waf`, `directives` text, `load_owasp_crs`. Rule set only as `Include` lines; no rule list | None | Rule hits as one long `msg` string; block summary line; audit log is a separate file | Config easy. Events need owner setup (engine On, a file log, optional audit log) |
| Rate limit | Yes: handler `rate_limit`, zones with key, window, max_events | `caddy_rate_limit_*` on master only, not in v0.1.0 | INFO `rate limit exceeded` with zone, wait, remote_ip | Easy (config, 429 logs); metrics need a pinned build |
| Cache (Souin) | Yes: handler `cache` and `apps.cache` | Own `/souin-api/metrics`, off unless `api { prometheus }` | Per-request status is a **response header** in the access log | Easy via access log; stats API needs owner setup |
| GeoIP | Yes: handler `geoip`; `db_path`, `trust_header` | None | Adds nothing to logs; only the `{geoip.country_code}` placeholder | Needs owner setup (`log_append`) |
| caddy-l4 | Yes: `apps.layer4.servers` | `caddy_layer4_proxy_*` (proxy handler only) | Connections are DEBUG; errors ERROR | Config and metrics easy; connection log not feasible by default |
| Brotli | Yes: `encodings.br` inside `encode` | None | `Content-Encoding: br` in `resp_headers` | Trivial; low value |
| certmagic-s3 | `/config/storage` (contains secrets) | None | INFO on start; rest DEBUG | Nothing beyond the TLS view; redact |
| Cloudflare DNS | `provider.name` in TLS policy (token inside) | None | None of its own | Already shown (`tls.ts` reads only the name) |

---

## 1. WAF (corazawaf/coraza-caddy)

Sources: [coraza-caddy @5d6d37ab (main)](https://github.com/corazawaf/coraza-caddy/tree/5d6d37ab2162f09ae4e3fd6c3d6bca45747910ad) and [@v2.6.2](https://github.com/corazawaf/coraza-caddy/tree/v2.6.2); [coraza @v3.8.1](https://github.com/corazawaf/coraza/tree/v3.8.1); [CRS @v4.30.0](https://github.com/coreruleset/coreruleset/tree/v4.30.0).

### 1.1 Config in the admin API

- Module ID `http.handlers.waf` (`coraza.go` L72-77), so the route entry is `{"handler":"waf", ...}`. Fields (`corazaModule` struct, L58-69): `directives` (string), `load_owasp_crs` (bool), `tx_id_req_header` (string), deprecated `include` (string list).
- Find it: walk `/config/apps/http/servers/<srv>/routes[]/handle[]`, recursing into `subroute` handlers, for `handler == "waf"`. Fairway already fetches `/config/apps/http/servers` (`src/server/caddy-admin.ts`). It needs `order coraza_waf first` in the Caddyfile ([README](https://github.com/corazawaf/coraza-caddy/blob/5d6d37ab2162f09ae4e3fd6c3d6bca45747910ad/README.md) L55).
- **What the config does and does not tell you.** `directives` is the raw SecLang text. With `load_owasp_crs` the usual content is `Include @coraza.conf-recommended`, `Include @crs-setup.conf.example`, `Include @owasp_crs/*.conf`, `SecRuleEngine On` (README L117-131). The `@` paths are compiled into the binary (README L97-106), so the **loaded rules cannot be listed through the admin API**. Fairway can only show: the Include lines, `SecRuleEngine`, `SecAction ... setvar:tx.*` tuning (paranoia level, anomaly threshold), `SecRuleRemoveById/ByTag`, `SecRuleUpdate*`, `SecAuditEngine/SecAuditLog*`, and custom `SecRule`s. Parsing SecLang line continuations (`\`) is needed; treat the result as a best-effort summary.
- **Engine mode matters.** `coraza.conf-recommended` ships `SecRuleEngine DetectionOnly` ([coraza.conf-recommended L8](https://github.com/corazawaf/coraza/blob/v3.8.1/coraza.conf-recommended)). If the owner does not add `SecRuleEngine On` after the Includes, nothing is ever blocked. This is the single most useful warning Fairway can show.
- **CRS version** is not in the config. It appears in every rule log line as `[ver "OWASP_CRS/4.x.y"]` (`rule_match.go` L198-200; each CRS rule carries `ver:'OWASP_CRS/4.30.0'`, e.g. [REQUEST-949 L233](https://github.com/coreruleset/coreruleset/blob/v4.30.0/rules/REQUEST-949-BLOCKING-EVALUATION.conf)). v2.6.2 embeds v4.25.0 (`go.mod` at the tag), main embeds v4.30.0.
- CRS defaults, from [REQUEST-901-INITIALIZATION.conf](https://github.com/coreruleset/coreruleset/blob/v4.30.0/rules/REQUEST-901-INITIALIZATION.conf): inbound anomaly threshold 5 (L83), reporting level 4 (L103), blocking paranoia level 1 (L123). Concept docs: [anomaly scoring](https://coreruleset.org/docs/2-how-crs-works/2-1-anomaly_scoring/), [paranoia levels](https://coreruleset.org/docs/2-how-crs-works/2-2-paranoia_levels/).
- Changed Include'd files on disk do not change the JSON, so Caddy skips the reload unless forced ([TROUBLESHOOTING.md](https://github.com/corazawaf/coraza-caddy/blob/5d6d37ab2162f09ae4e3fd6c3d6bca45747910ad/TROUBLESHOOTING.md), "not reloaded"). Relevant to Fairway's deploy flow if rules live in files.

### 1.2 Metrics and own endpoints

None. The repo has no Prometheus import in its Go files (checked `coraza.go`, `http.go`, `interceptor.go`, `logger.go`; `client_golang` is only an indirect dependency in `go.mod`) and registers no admin route. There are no per-rule counters anywhere. The only metric-like signal is Caddy's own `caddy_http_request_duration_seconds_count{code="403",host=...}`, which also counts every other 403.

### 1.3 What it writes to the logs

Three separate outputs.

**A. Rule match lines (Caddy logger `http.handlers.waf`).** `newErrorCb` (`coraza.go` L337-358) is Coraza's error callback. It logs `MatchedRule.ErrorLog()` as the **message string** with no structured fields. It fires only for rules that have the `log` action (`transaction.go` L631 `if tx.WAF.ErrorLogCb != nil && r.Log`). CRS sets `log` through `SecDefaultAction "phase:N,log,auditlog,pass"` in `crs-setup.conf.example` L97-101.

Level by rule severity (`coraza.go` L340-356): emergency/alert/critical/error to ERROR; warning to WARN; notice and info to INFO; debug to DEBUG; **unset severity falls to WARN**.

Format (`rule_match.go` L260-297, L189-205): `[client "<ip>"] <verdict> <msg> [file ".."] [line ".."] [id ".."] [rev ".."] [msg ".."] [data ".."] [severity ".."] [ver ".."] [maturity ".."] [accuracy ".."] [tag ".."]... [hostname ".."] [uri ".."] [unique_id ".."]`. Values are Go `%q`-quoted. `msg` and `data` are cut at 280 characters. Extra chain matches add `[msg_match_N ..] [data_match_N ..]`.

Verdict text (`rule_match.go` L299-313) is how Fairway tells blocked from detected:
- `Coraza: Access denied (phase N).` (also `allowed`, `dropped`, `redirected`): the rule disrupted. `Disruptive_` is true only when the engine is On (`transaction.go` L609-617).
- `Coraza: Warning.`: the rule matched but did not disrupt (a `pass` rule, or **any** rule when the engine is DetectionOnly).

Constructed example (CRS detection rule, engine On, blocking mode; wrapped here, one line in the file):

```json
{"level":"error","ts":1731240000.123,"logger":"http.handlers.waf",
 "msg":"[client \"198.51.100.7\"] Coraza: Warning. SQL Injection Attack Detected via libinjection [file \"@owasp_crs/REQUEST-942-APPLICATION-ATTACK-SQLI.conf\"] [line \"123\"] [id \"942100\"] [rev \"\"] [msg \"SQL Injection Attack Detected via libinjection\"] [data \"Matched Data: s&1c found within ARGS:q: 1' or '1'='1\"] [severity \"critical\"] [ver \"OWASP_CRS/4.30.0\"] [maturity \"0\"] [accuracy \"0\"] [tag \"attack-sqli\"] [tag \"paranoia-level/1\"] [hostname \"\"] [uri \"/search?q=1'%20or%20'1'='1\"] [unique_id \"kQeXgPZcLmNtRaVb\"]"}
```

The blocking rule 949110 has no `severity` action ([REQUEST-949 L226-233](https://github.com/coreruleset/coreruleset/blob/v4.30.0/rules/REQUEST-949-BLOCKING-EVALUATION.conf)), so its line reads `[severity "unknown"]` and, by the L354 default, is logged at WARN (derived from source, not observed):

```json
{"level":"warn","ts":1731240000.125,"logger":"http.handlers.waf",
 "msg":"[client \"198.51.100.7\"] Coraza: Access denied (phase 2). Inbound Anomaly Score Exceeded (Total Score: 5) [file \"...\"] [line \"...\"] [id \"949110\"] [rev \"\"] [msg \"Inbound Anomaly Score Exceeded (Total Score: 5)\"] [data \"\"] [severity \"unknown\"] [ver \"OWASP_CRS/4.30.0\"] [maturity \"0\"] [accuracy \"0\"] [tag \"anomaly-evaluation\"] [tag \"OWASP_CRS\"] [hostname \"\"] [uri \"/search?...\"] [unique_id \"kQeXgPZcLmNtRaVb\"]"}
```

Parsing notes: after `JSON.parse`, repeat `\[(\w+) "((?:[^"\\]|\\.)*)"\]` and unescape. `[hostname]` is the **server IP, which is empty** here because coraza-caddy calls `ProcessConnection(client, port, "", 0)` (`http.go` L22-23). The HTTP host is not on these lines. `[client]` honours Caddy's `client_ip` var (`utils.go` `getClientAddress` L54-80), so trusted proxies work.

A one-per-request summary exists too: CRS rule 980170 logs `Anomaly Scores: (Inbound Scores: blocking=.. detection=.., ... threshold=..) - (... SQLI=.., XSS=.., ... COMBINED_SCORE=..)` in phase 5 ([RESPONSE-980-CORRELATION.conf L86-100](https://github.com/coreruleset/coreruleset/blob/v4.30.0/rules/RESPONSE-980-CORRELATION.conf)). Which requests get it depends on `tx.reporting_level` (default 4: any request with a non-zero detection score, L43-83). Useful for a "score per request" column.

**B. Block summary line (`WAF rule violation detected`).** Only when a request is actually interrupted. `logViolation` (`coraza.go` L265-275), level ERROR, logger `http.handlers.waf`:

```json
{"level":"error","ts":1731240000.126,"logger":"http.handlers.waf","msg":"WAF rule violation detected",
 "hostname":"app.example.test","uri":"/search?q=...","client_ip":"198.51.100.7","unique_id":"kQeXgPZcLmNtRaVb",
 "rule_id":949110,"action":"deny"}
```

- `hostname` here **is** the HTTP Host (`r.Host`), and `unique_id` equals the `[unique_id]` in the rule lines. This is the only WAF line with a host, so Fairway can join rule lines to a host through `unique_id` for blocked requests.
- **v2.6.2 lacks `rule_id` and `action`** ([v2.6.2 coraza.go L236-242](https://github.com/corazawaf/coraza-caddy/blob/v2.6.2/coraza.go)). Main adds them and also logs response-phase blocks (PR #361). v2.5.0 used the raw `RemoteAddr` for `client_ip`.
- It is **not** emitted in DetectionOnly: it keys on `tx.Interruption()`, and in DetectionOnly the interruption is parked in `detectionOnlyInterruption` (`transaction.go` L335-352). Only the rule lines (A) exist then, all "Warning".
- Status: `deny` returns the rule's `status` or **403** (`interceptor.go` L338-349). Other actions fall back to the handler default. Caddy's own `http.log.error` entry for it is DEBUG (see conventions), carrying `err_id` = the transaction id ([logging.go `errLogValues` L234-248](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddyhttp/logging.go)).

**C. Audit log (Coraza's own file, not Caddy's logger).** Written by Coraza directly, unaffected by Caddy's log level (TROUBLESHOOTING.md, last section). **Off unless the owner sets `SecAuditLog <path>`**: the recommended conf has it commented out, `SecAuditEngine RelevantOnly`, `SecAuditLogParts ABIJDEFHZ`, `SecAuditLogType Serial`, `SecAuditLogFormat Native` ([L226-252](https://github.com/corazawaf/coraza/blob/v3.8.1/coraza.conf-recommended)). For machine reading the owner needs `SecAuditLogFormat JSON` ([directive docs](https://coraza.io/docs/seclang/directives/)). The JSON shape is in `internal/auditlog/auditlog.go` L14-24, L70-90, L261-269, L344-404:

```
{"transaction":{"timestamp","unix_timestamp","id","client_ip","client_port","host_ip","host_port","server_id",
  "request":{"method","protocol","uri","http_version","headers":{..},"body","files","args","length"},
  "response":{"protocol","status","headers","body"},
  "producer":{"connector","version","server","rule_engine","stopwatch","rulesets"},
  "highest_severity","is_interrupted"},
 "messages":[{"actionset","message","error_message","data":{"file","line","id","rev","msg","data","severity","ver","maturity","accuracy","tags":[..],"raw"}}]}
```

`transaction.id` equals `unique_id`; `severity` is an int 0-7 (no `MarshalJSON` in `types/severity.go`); `is_interrupted` says blocked. This is the only source with the Host header and the full rule list per request, but it holds request headers and bodies (secrets, tokens), and the file is a separate mount for Fairway. Treat as optional.

### 1.4 Cheapest reliable surface, and what is fragile

- Cheapest: tail the file that receives `http.handlers.waf` and parse lines A and B. Fairway already has the machinery (`scanLinesBackward` in `src/server/logs.ts`; logger-to-file resolution from `/config/logging` in `host-logs.ts`, which today only looks at `http.log.access.*`). The default log in `dev/Caddyfile.sample` already catches these lines.
- Owner must: (1) have a log writing to a file that is not excluding `http.handlers.waf`; (2) set `SecRuleEngine On` to block, else expect only "Warning"; (3) keep rules on `log` (CRS default does).
- Host attribution for non-blocked hits is not possible from logs A. Options: the block line (B) for blocked ones; or the owner adds `log_append waf_tx {http.transaction_id}` (the WAF sets that placeholder, `coraza.go` L225-226) **before** the WAF in handler order, because Caddy's late `log_append` still adds its field when a later handler errors ([logappend.go L63-120](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/caddyhttp/logging/logappend.go)) but never runs if it sits after a WAF that already returned the error. With `order coraza_waf first` that needs an explicit `order`. The reordering is **unverified in practice**.
- Fragile: the line text is a human format, not an API. It is stable in Coraza since 3.x but has no contract. The v2.6.2/main field difference above. `[hostname]` empty. 280-char truncation. Level does not equal blocked (a CRS "Warning" at ERROR level).
- Impossible: listing loaded rules or per-rule hit counts from Caddy; knowing the engine mode at runtime other than by parsing `directives`; any WAF metrics.
- Optional enrichment: ship a static CRS id-to-name/tag table keyed by `[ver]`, because lines already carry `msg` and `tag`, so this is not needed for display.

---

## 2. Rate limit (mholt/caddy-ratelimit)

Sources: [master @5625512](https://github.com/mholt/caddy-ratelimit/tree/5625512f24f6f59d6f64fb3aafe5eecff0b286db) and [v0.1.0](https://github.com/mholt/caddy-ratelimit/tree/v0.1.0).

1. **Config.** ID `http.handlers.rate_limit` (`handler.go` L84-92), handler name `rate_limit`. JSON per [README](https://github.com/mholt/caddy-ratelimit/blob/5625512f24f6f59d6f64fb3aafe5eecff0b286db/README.md) L76-97: `rate_limits.<zone>` with `match[]`, `key` (e.g. `{http.request.remote.host}`), `window`, `max_events`, `ipv4_prefix`, `ipv6_prefix` (`ratelimit.go` L30-60), plus `jitter`, `sweep_interval`, `log_key`, `disable_metrics`, `distributed`. Zone names are global across the config. Algorithm: sliding window, one ring buffer per key (README L50-52). Walk the same route tree as for the WAF.
2. **Metrics (master only).** Registered into Caddy's registry, so they appear in `/metrics` (the admin one Fairway already reads) with `GetMetricsRegistry()` (`handler.go` L95-114, `metrics.go` L28-88). Names and labels:
   - `caddy_rate_limit_declined_requests_total{zone,key}`, `caddy_rate_limit_requests_total{zone,key}`, `caddy_rate_limit_process_time_seconds{zone,key}` (histogram), `caddy_rate_limit_keys_total{zone}` (gauge), `caddy_rate_limit_config{zone,max_events,window,ipv4_prefix,ipv6_prefix}` (counter, reported at provision).
   - **Parsing trap:** each event is recorded twice, once with `key=""` (zone total) and once with the real key (`recordDeclinedRequest` L151-159). Summing all series double-counts. Take `key==""` for totals. The per-key series are unbounded-cardinality (key is often the client IP); set `disable_metrics` if that matters. Requests matching no zone are counted under `zone="false"` (`recordRequest` L126-137).
   - Absent in v0.1.0 (see conventions).
3. **Logs.** `rateLimitExceeded` (`handler.go` L293-335, identical in v0.1.0 L200-240): logger `http.handlers.rate_limit`, **INFO**, msg `rate limit exceeded`, fields `zone`, `wait` (duration, ns in JSON), `remote_ip` (taken from `r.RemoteAddr`, so it is the proxy or CDN address, not `client_ip`, behind a proxy), and `key` only if `log_key` is true (off by default because keys may be sensitive). The response is 429 with `Retry-After` set (L301). It also emits a Caddy event `rate_limit_exceeded` and sets placeholder `{http.rate_limit.exceeded.name}`; these are only useful inside Caddy config. No log line per allowed request.
   ```json
   {"level":"info","ts":1731240100.5,"logger":"http.handlers.rate_limit","msg":"rate limit exceeded","zone":"api","wait":2.5,"remote_ip":"198.51.100.7"}
   ```
   (constructed; `wait` encoding follows Caddy's default duration encoder, **unverified**).
4. **Cheapest surface.** (a) Config panel of zones. (b) Per-host 429 counts from Caddy's own `caddy_http_request_duration_seconds_count{code="429",host=..}`: no plugin cooperation, but includes upstream 429s. (c) The INFO log lines in the same default log file as the WAF feed: gives zone, client, time, no host. For the host, the access log has the 429 status and the `Retry-After` header in `resp_headers` (the handler sets it on the response before returning the error; access-log capture of it is **unverified**). Fragile: metrics need a build newer than v0.1.0; `remote_ip` behind proxies; no "who is currently limited" endpoint exists (state is in memory, no admin API; `rateLimits` usage pool in `handler.go` L385).

---

## 3. Cache (caddyserver/cache-handler, Souin)

Sources: [cache-handler v0.17.0](https://github.com/caddyserver/cache-handler/tree/v0.17.0) (equals master at 07d7af2; 0 commits ahead), depends on [Souin v1.7.9](https://github.com/darkweak/souin/tree/v1.7.9) (`go.mod`).

1. **Config.** Handler ID `http.handlers.cache` (`httpcache.go` L84-89), app ID `cache` (`const moduleName` L19, `app.go`). So: per-route `{"handler":"cache", ...}` and global `/config/apps/cache` (`cache_keys`, `api`, `log_level`, ttl, stale, storage provider such as badger/etcd/nuts/olric; fields in `app.go` L26-30, `httpcache.go`). Options list: [README](https://github.com/caddyserver/cache-handler/blob/v0.17.0/README.md) L20-160, L360-422. Storage defaults to an in-memory dev store with a warning (`middleware.go` L214 in Souin).
2. **Metrics and API.** Souin registers `souin_request_upstream_counter`, `souin_request_revalidation_counter`, `souin_no_cached_response_counter`, `souin_cached_response_counter` (counters) and `souin_avg_response_time` (histogram, milliseconds) ([pkg/api/prometheus/prometheus.go L16-21, L99-107](https://github.com/darkweak/souin/blob/v1.7.9/pkg/api/prometheus/prometheus.go)). They use the **default** Prometheus registry, not Caddy's, so they are **not** in Caddy's `/metrics` (Caddy serves only its context registry: [modules/metrics/metrics.go L66, L115](https://github.com/caddyserver/caddy/blob/v2.11.9/modules/metrics/metrics.go)). They are served by the Souin API at `<api.basepath>/metrics`, default `/souin-api/metrics`, only if the owner enabled `api { prometheus }` (`pkg/api/main.go` L28-38). The cache-handler registers an admin module `admin.api.souin` with a catch-all `/{params...}` (`admin.go` L28-34, L84-92), so these paths are reachable on the admin socket Fairway already uses. Whether the catch-all clashes with Caddy's own routes is **unverified**.
   Souin API (`pkg/api/souin.go` L50-70, L245-262): `GET /souin-api/souin` lists stored keys, `/souin-api/souin/<regex>` filters, `/surrogate_keys`, `PURGE .../flush`. Disabled unless `api { souin }` is set. No hit/miss counters there. A `debug` endpoint exposes pprof (`pkg/api/debug/debug.go`); Fairway should never call it.
3. **Logs and headers.** The useful signal is the **`Cache-Status` response header** (RFC 9211 style, [README L14](https://github.com/caddyserver/cache-handler/blob/v0.17.0/README.md)), which Caddy's access log records in `resp_headers` by default (`logRequest`). Shapes from source (`pkg/rfc/cache_status.go` L42, L80-123; `pkg/middleware/middleware.go` L393-601, L904-953):
   - hit: `<name>; hit; ttl=<s>; key=<key>; detail=<storer>`; stale adds `; fwd=stale`
   - miss and stored: `<name>; fwd=uri-miss; key=<key>` (+ `detail=NO-STORE-DIRECTIVE`, `UNCACHEABLE-STATUS-CODE`, `PRIVATE-OR-AUTHENTICATED-RESPONSE`, ...)
   - revalidation: `fwd=request; ... detail=REQUEST-REVALIDATION`
   - bypass: `fwd=bypass; detail=EXCLUDED-REQUEST-URI | UNSUPPORTED-METHOD | IS-MUTATION-REQUEST | ...`
   `<name>` is `cache_name`; its default value is **unverified**. `key` shows `*****` unless the key is displayable (`GetCacheKeyFromCtx`), so do not rely on it. Souin's own logger (`http.handlers.cache`) logs at INFO only config-loaded, reused-concurrent-response and error lines; per-request lines are DEBUG (`middleware.go` L624, L728 debug; L247, L715 info). `log_level` can be set per app/handler.
4. **Cheapest surface.** Per-host hit ratio computed from the existing host access log: count `resp_headers["Cache-Status"][0]` containing `; hit` versus `fwd=uri-miss`/`fwd=bypass`. Zero owner setup beyond `cache` and a host `log`. Fragile: the string is a draft-RFC format and Souin-specific details; only hosts that log. Optional: owner enables `api { souin prometheus }` for key counts and counters (separate fetch path, separate registry). Impossible: size/eviction stats (not exposed).

---

## 4. GeoIP (shift72/caddy-geo-ip)

Sources: [main @9d3030c](https://github.com/shift72/caddy-geo-ip/tree/9d3030cd110b1d1e6c7b81926f0565c55e35ff3b) (one commit past v0.6.0; the difference is in `override_country_code` handling).

1. **Config.** ID `http.handlers.geoip` (`main.go` L61-66), JSON `{"handler":"geoip","db_path","trust_header","download_frequency","reload_frequency","override_country_code","account_id","api_key"}`; the Caddyfile directive is `geo_ip` and needs `order geo_ip first` ([README](https://github.com/shift72/caddy-geo-ip/blob/9d3030cd110b1d1e6c7b81926f0565c55e35ff3b/README.md)). `api_key` can be a secret in the JSON: redact. Also `trust_header` shows which header the owner trusts for the client address.
2. **Metrics / endpoints.** None.
3. **Logs.** The module **adds nothing to access logs or headers**. Its only output is the placeholder `{geoip.country_code}` (L132, L145; `--` when no database is loaded, L128-134). Its own log lines: INFO at start/reload/download (`state.go` L37, L109, L132, L143), WARN `database does not exist`, `no database loaded, skipping geoip lookup` and `cannot split IP address` / `cannot parse IP address`, all with the usual `logger: http.handlers.geoip`. Lookup details are DEBUG. Only the **country ISO code** is exposed; city, region and ASN are not (models parse subdivisions and metro code but nothing sets a placeholder for them).
4. **Cheapest surface.** Needs the owner: `log_append country {geoip.country_code}` ([log_append docs](https://caddyserver.com/docs/caddyfile/directives/log_append)) in the site block so the access log carries it; then Fairway aggregates a "requests by country" table from `host-logs.ts` lines (`raw.country`). Without that, impossible from outside Caddy. Alternative (not checked): Fairway reads the `.mmdb` itself, but it would then need the file mounted and a lookup library.
   Fragile: it overwrites `r.RemoteAddr` from `trust_header` with the raw header value (L110-112), then `net.SplitHostPort` requires `ip:port`, so a bare-IP header like `X-Real-IP: 203.0.113.9` logs "cannot split IP address", skips the lookup and passes on (L116-126); this logs at WARN per request. Whether that happens depends on the owner's header; **unverified at runtime**. The README says env vars `GEO_ACCOUNT_ID`/`GEO_API_KEY`, the code reads `GEOIP_ACCOUNT_ID`/`GEOIP_API_KEY` (`main.go` L72-82; changelog 0.4.0 agrees with the code). Last commit 2022: effectively unmaintained.

---

## 5. Layer 4 (mholt/caddy-l4)

Sources: [v0.1.2](https://github.com/mholt/caddy-l4/tree/v0.1.2) (`layer4/server.go`, `layer4/app.go`, `modules/l4proxy/metrics.go` read at master eafc300; metrics.go and log sites match v0.1.2 apart from UDP changes).

1. **Config.** A separate app `layer4` (`layer4/app.go` L45): `/config/apps/layer4/servers/<name>` with `listen[]`, `routes[]` (each `match[]` such as `tls` SNI, `http`, `ssh`, `postgres`, ... and `handle[]` such as `proxy`, `tls`, `echo`), `idle_timeout`, `matching_timeout` (`server.go` L40-58). Handler `layer4.handlers.proxy` has `upstreams` (`modules/l4proxy/proxy.go` L74). Easy to list "port, matcher, upstream".
2. **Metrics.** Proxy handler only ([metrics.go L53-75](https://github.com/mholt/caddy-l4/blob/eafc300ef23bcb2a28cc329a18e1e98bcd2b7cee/modules/l4proxy/metrics.go)): `caddy_layer4_proxy_connections_total{upstream}`, `caddy_layer4_proxy_active_connections{upstream}`, `caddy_layer4_proxy_upstream_healthy{upstream}` (1/0, active health checks). Registered in Caddy's registry via `ctx.GetMetricsRegistry()` so they show in `/metrics`. Not per client, not per listener. Plain `tls` termination or other handlers have no metrics.
3. **Logs.** Logger is the app logger (`ctx.Logger()` in `app.go` L53, name **`layer4`**, derived from the app module ID, unverified at runtime). Per-connection "started/stopped handling connection; connection stats" (remote, bytes read/written, duration) are **DEBUG**; matching timeouts WARN `matching connection`; handler errors ERROR `handling connection` (`server.go` L152-178, `routes.go` L146-150). No access-log equivalent exists.
4. **Cheapest surface.** A "TCP/UDP servers" list from config plus `upstream_healthy`/`active_connections` from `/metrics`. Per-connection history is not feasible unless the owner turns the whole logger to DEBUG (too noisy). Note `GET /reverse_proxy/upstreams` covers only the HTTP reverse proxy, not l4.

---

## 6. Brotli (ueffel/caddy-brotli)

[Repo @a11b086](https://github.com/ueffel/caddy-brotli/blob/master/brotli.go). ID `http.encoders.br` (`brotli.go` L23-28), one field `level`. It appears under the `encode` handler as `encodings.br` (`{"level":4}`); README: default level 4, ranges 0-11. No metrics, no logging code, no admin. The only runtime trace is `Content-Encoding: br` in `resp_headers` (generic Caddy behaviour). Value for Fairway: a badge "br enabled" per host, and at most a "% of responses brotli-encoded" column from host logs. Low priority; do it only as part of the config-summary feature.

## 7. certmagic-s3 (ss098/certmagic-s3) and Cloudflare DNS (caddy-dns/cloudflare)

- **S3 storage:** ID `caddy.storage.s3` (`s3.go` L189). Config at `/config/storage`: `host`, `bucket`, `prefix`, `insecure`, `use_iam_provider`, **`access_id`, `secret_key`** (L43-49). Placeholders `{env.*}` are expanded only at provision (`ReplaceKnown`, L97-100), so the live JSON shows the literal placeholder if the owner used one, but the actual secret if they wrote it inline or used `{$VAR}` (substituted at Caddyfile parse, Caddy docs: [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts#environment-variables)). Fairway must never print this object raw. Logs: INFO "using secret_key and access_id..." / "using iam aws provider" at provision (L167-170); store/load/delete/stat are DEBUG; stat errors ERROR (L281). No metrics.
- **Cloudflare:** ID `dns.providers.cloudflare` ([cloudflare.go L40-43](https://github.com/caddy-dns/cloudflare/blob/master/cloudflare.go)). Appears at `/config/apps/tls/automation/policies/<n>/issuers/<m>/challenges/dns/provider` as `{"name":"cloudflare","api_token":...}`. Token placeholders are replaced in `Provision` (L49-52); same inline-secret caveat. `src/server/tls.ts` L117-134 reads only `provider.name`, which is safe and already enough. It has no logs of its own; ACME/DNS challenge failures come from `tls.issuance.acme` and are already covered by Fairway's `/api/tls/last-error` path.
- Nothing more is worth building. One defensive item: make sure no future "raw config" view passes `/config/storage` or issuer `provider` objects unredacted (the repo is public and the UI has no login beyond the owner login, ADR 0005).

---

## 8. Suggested features, ranked

| # | Feature | Effort | Owner must configure | Notes |
|---|---|---|---|---|
| 1 | **Plugin summary per host** from the running config: WAF (engine mode, CRS yes/no, Includes, paranoia/threshold, removed rule ids, audit log on/off), rate-limit zones (key, `N / window`), cache on, geoip on, `encode` formats, l4 servers. Warn on WAF in DetectionOnly | S-M | Nothing (WAF needs `directives` to be present) | Same route walk as `routes.ts`. SecLang parsing is best effort. Redact storage/DNS/geoip secrets |
| 2 | **Blocked/limited counts per host** from `caddy_http_request_duration_seconds_count{code="403"|"429"}`, extending `metrics.ts` (it currently folds codes into 4xx) | S | `metrics { per_host }` (already optional) | Cannot tell WAF 403 from other 403s; labels fold into `_other` on HTTP servers |
| 3 | **WAF event feed**: table of rule hits (time, id, msg, severity, verdict blocked/detected, client, uri, CRS ver), grouped by `unique_id`, with the block line giving the host | M | A file log that includes `http.handlers.waf`; `SecRuleEngine On`; ideally coraza-caddy newer than v2.6.2 (`rule_id`/`action`) | Reuses `scanLinesBackward` and logger resolution. Optional: `log_append waf_tx {http.transaction_id}` for host join on non-blocked hits (reordering unverified) |
| 4 | **Rate-limit events + zones table**: 429 lines (zone, remote_ip, wait) from the same feed; zone metrics where available | S after #3 | Nothing for logs; for metrics a build newer than v0.1.0 (`@master`/commit) | Parse `key==""` series only |
| 5 | **Cache hit ratio per host** from `Cache-Status` in host access logs | S-M | A `log` for the host; `cache` handler | Souin API/metrics only if owner adds `api { souin prometheus }` |
| 6 | **Requests by country** | S | `log_append country {geoip.country_code}` in each site | Plugin quirks (trust_header format, 2022 code) |
| 7 | **l4 panel**: servers/routes/upstreams plus the three `caddy_layer4_proxy_*` gauges | S | Nothing | Per-connection history not feasible |
| 8 | **WAF audit log viewer** (full request, all rules) | L | `SecAuditLog` path on a mounted volume, `SecAuditLogFormat JSON`; sensitive data (headers, bodies) | Only if the event feed proves insufficient |
| 9 | Static CRS id-to-name/tag lookup keyed by `[ver]` | M | Nothing | Not needed: log lines already carry msg and tag |

Not feasible: listing the loaded rule files or individual rule definitions via Caddy; WAF or GeoIP metrics; cache size/eviction stats; l4 per-connection logs at default level; anything for brotli, S3 storage or Cloudflare beyond what the TLS view already shows.

## Open points to verify on a real build

1. `caddy build-info` in the dev image: actual plugin versions (especially ratelimit v0.1.0 vs master, coraza-caddy and its embedded CRS).
2. One real WAF block with CRS: confirm the two-line pattern (rule line then violation line), the level of the 949110 line, and `[severity "unknown"]`.
3. `log_append` before `coraza_waf` with an explicit `order`: does the transaction id land in the access log of a blocked request?
4. Whether the Souin admin catch-all route coexists with Caddy's built-in admin routes on the unix socket.
5. `wait` field encoding in the rate-limit line, and whether `Retry-After` shows in `resp_headers` for a 429.
