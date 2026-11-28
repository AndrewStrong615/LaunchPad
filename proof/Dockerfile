# Liftoff's test browser (proof/server.mjs), built from the repository root
# by render.yaml. The Playwright image already has Chromium and its system
# libraries; its version must match proof/package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PORT=10000
WORKDIR /srv
COPY proof/package.json proof/package-lock.json proof/
RUN cd proof && npm ci --omit=dev --no-audit --no-fund
# The network guard reuses Liftoff Cloud's private-address rules.
COPY cloud/lib/safe-fetch.mjs cloud/lib/safe-fetch.mjs
COPY proof/*.mjs proof/

# Chromium runs as the image's unprivileged user, never as root.
USER pwuser
EXPOSE 10000
CMD ["node", "proof/server.mjs"]
