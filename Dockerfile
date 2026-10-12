# ---- build stage ----------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:22-bookworm-slim
# git is needed by the extract stage (shallow clones). ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# Run as the unprivileged user that ships with the node image.
RUN mkdir -p /data/objects /data/work && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db ./db
COPY --chown=node:node package.json ./
USER node
EXPOSE 4200
CMD ["node", "dist/api/server.js"]
