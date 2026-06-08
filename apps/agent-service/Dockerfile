FROM node:20-alpine

RUN apk add --no-cache openssh-client git

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .

# Write SSH key from env at startup
CMD sh -c 'mkdir -p /root/.ssh && echo "$SSH_PRIVATE_KEY" > /root/.ssh/id_ed25519 && chmod 600 /root/.ssh/id_ed25519 && echo "StrictHostKeyChecking no" > /root/.ssh/config && node server.js'

EXPOSE 3100
