FROM node:20-alpine

# System deps for git + Playwright/Chromium
RUN apk add --no-cache \
    git openssh \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Let Playwright download its own Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install chromium --with-deps 2>/dev/null || true

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .

RUN git config --global user.email "agent@ottaly.co.uk" && \
    git config --global user.name "Ottaly Agent"

EXPOSE 3100

CMD ["node", "server.js"]
