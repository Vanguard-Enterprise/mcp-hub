# syntax=docker/dockerfile:1.7
# Build stage: install with pnpm, compile TypeScript, drop dev dependencies.
FROM node:24-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@12.16.1
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Runtime stage: distroless Node, non-root (uid 65532), no shell.
FROM gcr.io/distroless/nodejs24-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["dist/index.js"]
