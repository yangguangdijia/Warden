FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a
WORKDIR /app
RUN install -d -m 0700 -o node -g node /var/lib/ops
COPY ops-bridge/ ops-bridge/
COPY ops-executor/ ops-executor/
COPY warden/policy.mjs warden/policy.mjs
COPY deploy/gateway.mjs deploy/gateway.mjs
USER 1000:1000
