FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && chmod -R a+rX /ms-playwright

COPY --chown=node:node server.js ./
COPY --chown=node:node jobctl.js ./
COPY --chown=node:node cloud ./cloud
COPY --chown=node:node product ./product
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN node scripts/verify_product_build.js
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
