# The same plugin build as the production Caddy, so the dev editor validates a real Caddyfile
# (geo_ip, coraza_waf, rate_limit, cache, S3 storage and the Cloudflare DNS module).
FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/mholt/caddy-l4 \
    --with github.com/corazawaf/coraza-caddy/v2 \
    --with github.com/shift72/caddy-geo-ip \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/caddyserver/cache-handler \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/ss098/certmagic-s3

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
