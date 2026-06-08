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

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .

RUN git config --global user.email "agent@ottaly.co.uk" && \
    git config --global user.name "Ottaly Agent"

EXPOSE 3100

CMD ["node", "server.js"]
