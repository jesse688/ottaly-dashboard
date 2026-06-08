FROM node:20-alpine

RUN apk add --no-cache git openssh

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .

# Git config for commits
RUN git config --global user.email "agent@ottaly.co.uk" && \
    git config --global user.name "Ottaly Agent"

EXPOSE 3100

CMD ["node", "server.js"]
