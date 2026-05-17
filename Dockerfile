FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM efabless/openlane:latest AS openlane

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV PATH="/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates yosys \
  && rm -rf /var/lib/apt/lists/*

COPY --from=openlane /nix /nix
COPY --from=openlane /root/.nix-profile /root/.nix-profile

RUN volare enable --pdk sky130 --metadata-file /root/.nix-profile/bin/dependencies/tool_metadata.yml

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build
COPY index.html ./index.html

EXPOSE 8080
CMD ["node", "build/cloud-api.js"]
