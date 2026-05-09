FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npx tsc

# --- runtime stage ---
FROM node:20-alpine

RUN apk add --no-cache sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY README.md LICENSE CHANGELOG.md ./

VOLUME ["/root/.terminal-history-mcp"]

ENTRYPOINT ["node", "dist/cli.js"]
