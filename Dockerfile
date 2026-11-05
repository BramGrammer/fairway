FROM node:26-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY web/package*.json ./web/
# The root postinstall installs the web app's dependencies too.
RUN npm ci
COPY tsconfig.server.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
# Pull in Alpine's latest security fixes for the base image's system libraries.
RUN apk upgrade --no-cache
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# `caddy fmt` formats Caddyfiles; the binary is only used for that, never to run Caddy.
COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
