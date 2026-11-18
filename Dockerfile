FROM node:24-alpine

# 应用本身零第三方依赖：服务端 + 主页面 + 管理页
WORKDIR /app
COPY server.js index.html admin.html ./

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/meetup.db

# 说明：默认以 root 运行，因为 compose 里用的是 ./data 绑定挂载，
# 宿主机目录的属主不确定；如果要跑成非 root，把下面 USER 两行取消注释，
# 并确保宿主机上 chown -R 1000:1000 ./data
RUN mkdir -p /data
# RUN chown -R node:node /app /data
# USER node

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
