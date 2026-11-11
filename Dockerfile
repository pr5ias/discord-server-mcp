# Keeps the bots online with their automations (role menus, welcomes, tickets, slash commands, moderation
# log), or serves the MCP tools over HTTP. Settings, bots and automations live in the /data volume.
#   docker build -t discord-server-mcp .
#   docker run -d --name discord-bot -v discord-data:/data -e DISCORD_BOT_TOKEN=... discord-server-mcp
#   docker run -d -p 3333:3333 -v discord-data:/data -e DISCORD_BOT_TOKEN=... \
#     -e DISCORD_MCP_HTTP_TOKEN=<long secret> discord-server-mcp serve --http --host 0.0.0.0
FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE README.md ./
COPY dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOME=/data NODE_ENV=production
VOLUME /data
EXPOSE 3333
ENTRYPOINT ["node", "/app/dist/index.mjs"]
CMD ["run"]
