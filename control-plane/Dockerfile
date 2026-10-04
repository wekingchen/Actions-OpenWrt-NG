FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

COPY control-plane/package.json control-plane/package-lock.json ./

# server.mjs 会静态 import fflate；镜像必须自行安装 production
# dependencies，不能依赖 CI 工作区里碰巧存在的 node_modules。
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY control-plane/server.mjs ./server.mjs
COPY control-plane/lib ./lib
COPY control-plane/public ./public

RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV CONTROL_PLANE_DB=/data/control-plane.db
VOLUME ["/data"]
EXPOSE 8787

CMD ["node", "server.mjs"]
