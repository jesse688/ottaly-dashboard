FROM node:20-alpine

RUN apk add --no-cache openssh-client git

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .
COPY apps/agent-service/agent_key /root/.ssh/id_ed25519
COPY apps/agent-service/agents /app/agents-default

RUN chmod 600 /root/.ssh/id_ed25519 && \
    echo "StrictHostKeyChecking no" > /root/.ssh/config && \
    chmod 600 /root/.ssh/config

# Seed agent files from defaults if volume is empty on first run
COPY apps/agent-service/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3100

CMD ["/docker-entrypoint.sh"]
