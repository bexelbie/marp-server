FROM node:20-alpine AS base

RUN npm install -g @marp-team/marp-cli

WORKDIR /app

COPY package.json ./
RUN npm install

COPY sync.js ./
COPY start.sh ./
RUN chmod +x /app/start.sh

RUN mkdir -p /data /themes
COPY placeholder.md /data/.placeholder.md

EXPOSE 8080

CMD ["/app/start.sh"]
