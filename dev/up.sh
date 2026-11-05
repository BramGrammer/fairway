#!/bin/sh
set -e
cd "$(dirname "$0")"
mkdir -p run/logs run/data
[ -f run/Caddyfile ] || cp Caddyfile.sample run/Caddyfile
docker compose -f compose.yaml up --build -d
echo
echo "Fairway:    http://127.0.0.1:3000"
echo "Dev Caddy:  http://127.0.0.1:8080  (and :8081)"
echo "Reset with: npm run dev:reset"
