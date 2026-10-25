FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production PORT=10000 MCP_DEVOPS_HTTP_HOST=0.0.0.0 MCP_DEVOPS_STATE_DIR=/var/data/mcp-state
EXPOSE 10000
CMD ["node", "dist/index.js", "serve-http"]
