FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

COPY apps/agent-service/package.json .
RUN npm install

COPY apps/agent-service/server.js .

RUN git config --global user.email "agent@ottaly.co.uk" && \
    git config --global user.name "Ottaly Agent"

EXPOSE 3100

CMD ["node", "server.js"]
