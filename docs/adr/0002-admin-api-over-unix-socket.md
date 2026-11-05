# Reach the admin API over a Unix socket

Caddy's admin API is exposed as a Unix socket (`admin unix//run/caddy-admin/admin.sock|0660`) on a folder shared only with the Editor, instead of a TCP port.

## Why

- The admin API is unauthenticated and can replace the whole proxy configuration.
- Binding it to a TCP address inside the container (`0.0.0.0:2019`) would also expose it on the `reverse_proxy` network, where every proxied container could reach it.
- A socket in a shared folder is reachable only by the containers that mount that folder. It needs no network and no `origins` configuration.

## Consequences

- The published `2019:2019` port is removed from the Caddy stack.
- Socket permissions must let the Editor's user connect. This is verified in the local dev mode before deploying.
- Caddy recreates the socket on every start, so the Editor connects per request and does not hold a long-lived connection.

## Considered

- **Dedicated internal Docker network with `admin 0.0.0.0:2019`.** Simpler to debug, but still exposes the API on every network Caddy joins.
