# afterwrd on your own server (selfhost/README.md). Built from worker/:
#   docker build -f selfhost/Dockerfile -t afterwrd .
# The code is bundled exactly as for Cloudflare and run by workerd, the open-source engine Cloudflare's Workers run on,
# at the version this release was tested with (the one wrangler brings).

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# No install scripts, as in the release build (.github/workflows/release.yml): none are needed.
RUN npm ci --ignore-scripts
COPY . .
ENV WRANGLER_SEND_METRICS=false
RUN node selfhost/build.mjs /app/build \
  && cp node_modules/@cloudflare/workerd-linux-*/bin/workerd /app/workerd

FROM node:22-bookworm-slim
# Certificates for calls out to friends' sites and GitHub over HTTPS (workerd won't start without them).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 afterwrd \
  && mkdir /data && chown afterwrd /data \
  && for tool in owner recover new-group delete-group sites; do \
       printf '#!/bin/sh\nexec node /app/selfhost/afterwrd.mjs %s "$@"\n' "$tool" > "/usr/local/bin/$tool"; \
       chmod +x "/usr/local/bin/$tool"; \
     done
COPY --from=build /app/workerd /usr/local/bin/workerd
COPY --from=build --chown=afterwrd /app/build /app/build
COPY selfhost/serve.mjs selfhost/config.mjs selfhost/afterwrd.mjs /app/selfhost/
USER afterwrd
ENV AFTERWRD_DATA=/data AFTERWRD_BUILD=/app/build WORKERD=/usr/local/bin/workerd
VOLUME /data
EXPOSE 8080
CMD ["node", "/app/selfhost/serve.mjs"]
