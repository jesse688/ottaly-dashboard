FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

# email-finder-local deps (socks package for proxy4smtp)
COPY apps/admin-legacy/email-finder-local/package*.json ./email-finder-local/
RUN cd email-finder-local && npm install --omit=dev

# main server deps
COPY apps/admin-legacy/package*.json ./
RUN npm install --omit=dev

COPY apps/admin-legacy/ ./

EXPOSE 3000

CMD ["node", "server.js"]
