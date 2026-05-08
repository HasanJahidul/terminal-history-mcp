FROM node:20-alpine

# better-sqlite3 needs build tools for native compile on alpine.
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY README.md LICENSE CHANGELOG.md ./

# History DB lives in the user's home; persist via volume mount.
VOLUME ["/root/.terminal-history-mcp"]

ENTRYPOINT ["node", "dist/cli.js"]
