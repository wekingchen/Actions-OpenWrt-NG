FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY control-plane/package.json ./package.json
COPY control-plane/server.mjs ./server.mjs
COPY control-plane/lib ./lib
COPY control-plane/public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV CONTROL_PLANE_DB=/data/control-plane.db
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server.mjs"]
