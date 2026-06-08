FROM node:20-alpine

RUN apk add --no-cache openssh-client git

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .
COPY apps/agent-service/agent_key /root/.ssh/id_ed25519

RUN chmod 600 /root/.ssh/id_ed25519 && \
    echo "StrictHostKeyChecking no" > /root/.ssh/config && \
    chmod 600 /root/.ssh/config

EXPOSE 3100

CMD ["node", "server.js"]
