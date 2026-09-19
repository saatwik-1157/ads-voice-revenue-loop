# Node 24 because the whole project runs TypeScript natively through type
# stripping and uses node:sqlite without a flag. There is no build step and no
# compiler in the image - `src/*.ts` is what runs.
FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first, so a source change does not reinstall them. There is
# exactly one runtime dependency; the dev toolchain (eslint, tsc) is not
# installed here, which is also why nothing in the image can lint or test.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# The control layer travels with the code. Leaving it out does not fail - it
# falls back to defaults that are higher than anything anyone deliberately set,
# which is the worst possible way for this file to be missing.
COPY config ./config

# The database, the mock ad-account state and generated previews all live here.
# It must be a mounted volume: without one, every redeploy starts from an empty
# database, which for this system means losing the spend and revenue history the
# decision engine reasons over.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# Unprivileged. The process needs to write /app/data and nothing else.
USER node

ENV PORT=8787 \
    FL_DB_PATH=/app/data/autopilot.db \
    FL_LOG_FORMAT=json

EXPOSE 8787

# /health/ready is the one that actually queries the database, so it fails when
# the volume is missing or unwritable - which is the failure this catches.
# No curl in the slim image, and node is already here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --schedule runs the evaluation loop and the fast safety loop in this process.
# Drop it to serve webhooks only and drive cycles from outside.
CMD ["node", "src/cli.ts", "serve", "--schedule"]
