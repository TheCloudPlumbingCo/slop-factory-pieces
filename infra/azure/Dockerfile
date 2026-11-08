# The broker as one container. Build from the repository root, so the workspace packages are in the context:
#
#   docker buildx build --platform linux/amd64 -f infra/azure/Dockerfile -t <image> .
#
# Stage 1 bundles the server into one file with bun and esbuild. Stage 2 runs that file on Node 22.
# The final image has no node_modules and no source.

FROM oven/bun:1 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages ./packages
COPY infra ./infra
RUN bun install --frozen-lockfile --ignore-scripts
RUN cd infra/azure && bun run bundle

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /repo/infra/azure/dist/server.js ./server.js
USER node
EXPOSE 8080
# Container Apps sends SIGTERM and waits up to 30 s. main.ts handles it.
CMD ["node", "server.js"]
