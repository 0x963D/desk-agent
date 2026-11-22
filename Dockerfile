# The one-command check: `docker compose run --rm check`. The build installs everything over the network,
# and the run then needs no key and no network, which compose.yaml enforces with `network_mode: none`.
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# The CLI tests create throwaway Git repositories, so the image needs the git binary. It holds no Git history.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# The version package.json names in packageManager, so pnpm never fetches another one at run time.
RUN npm install --global pnpm@11.18.0 && npm cache clean --force

# CI=true keeps pnpm from checking the registry for a newer version during the run.
ENV CI=true
WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=node:node . .

CMD ["pnpm", "check"]
