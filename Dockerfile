# 构建阶段：把 MCP server 打成自包含单文件
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

# 先装依赖，锁文件不变时可复用缓存层
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm build:single

# 运行阶段：只需要 node 与那个单文件
FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=build /app/dist-single/dsh-feishu-mcp.mjs ./server.mjs

# 凭据由调用方通过环境变量注入，镜像里不留任何 secret
ENV FEISHU_DOMAIN=https://open.feishu.cn

# stdio 传输：进程通过 stdin/stdout 与 MCP 客户端通信
ENTRYPOINT ["node", "/app/server.mjs"]
