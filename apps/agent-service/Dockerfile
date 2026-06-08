FROM node:20-alpine

RUN apk add --no-cache openssh-client git bash

WORKDIR /app

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .
COPY apps/agent-service/start.sh .
RUN chmod +x start.sh

EXPOSE 3100

CMD ["bash", "start.sh"]
