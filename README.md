# 聚一聚 · 群聚会选址器

[![build](https://github.com/QCEnjoyLL/meetup-picker/actions/workflows/docker.yml/badge.svg)](https://github.com/QCEnjoyLL/meetup-picker/actions/workflows/docker.yml)

给 10~15 人的微信群决定「天南海北，去哪儿见」。

每个人用 **昵称 + 身份码** 登录，标出自己在哪、想去哪；页面算出对所有人最公平的**折中城市**，候选城市都配好了值得玩的地方。**所有改动实时同步**，页面顶部一直显示现在谁在房间里。

```
昵称 + 身份码  →  进房间（自动生成像素头像）
       ↓
填城市 / 预算 / 能来的月份 / 想去的地方
       ↓
地图上出现你的头像和昵称，推荐榜实时重排
```

## 一、身份码是什么

**它是每个人自己的简单密码**（4~12 位字母或数字），不是房间号：

- 第一次输入「昵称 + 身份码」→ 这个昵称归你，身份码成为你的密码
- 之后再用同一个昵称登录，**身份码必须对得上**，否则会被拒绝——所以别人顶不了你的位置
- 密码用 `scrypt` 加盐哈希存库，**不存明文**
- 同一昵称连续输错 10 次，锁 5 分钟
- 忘了身份码：换个昵称重来最省事（目前没有找回/重置入口）

房间本身靠**邀请链接**（`?r=xxxxxx`）进入；没有链接就点「帮我建一个」。

## 二、跑起来

镜像由 GitHub Actions 自动构建（amd64 + arm64）：

```bash
docker compose up -d          # 拉 ghcr.io/qqreugpnk/meetup-picker:latest
docker compose logs -f
```

打开 `http://服务器IP:8080` → 填昵称和身份码 → 「还没有房间，帮我建一个」→ 把地址发到群里。

> **首次使用**：仓库的 Actions 需要先跑成功一次，GHCR 里才会有镜像。
> 另外 GHCR 的包默认是私有的——如果部署时 `docker compose` 拉取报 `unauthorized`，去
> `https://github.com/users/QCEnjoyLL/packages/container/meetup-picker/settings` 把可见性改成 Public，
> 或者先 `docker login ghcr.io -u QCEnjoyLL -p <你的 PAT>`。

不想等 CI、自己构建：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

不用 Docker 也行，需要 Node **22.5+**（用到内置 `node:sqlite`）：

```bash
npm start                  # = node --disable-warning=ExperimentalWarning server.js
PORT=3000 DB_PATH=/tmp/x.db node server.js
```

## 三、数据（SQLite）

- 默认 `./data/meetup.db`（容器里是 `/data`），可用 `DB_PATH` 改
- WAL 模式，重启不丢；`rooms` / `members` / `thoughts` 三张表
- **备份**：停服务后整个 `data/` 目录拷走（WAL 文件也在里面）

```bash
docker compose stop && cp -a data data.bak && docker compose start
```

## 四、界面上的东西

- **随机头像**：按成员 id 哈希生成 5×5 对称像素图 + 12 色调色板，纯 SVG，不上传图片；顶部在线列表、成员列表、地图标记、想法墙都用它
- **顶部「已经登录的人」**：头像 + 昵称 + 在线绿点，实时增删
- **地图**：成员头像标在所在城市，下面跟昵称；叠 500/1000/1500 km 等距圈看谁在圈外
- **想法墙**：每人都能发言，只能删自己的
- **复制推荐榜**：把前 6 名整理成文字，直接粘到群里当结论

实时走 SSE（`GET /api/room/:id/stream`），断线自动重连，`EventSource` 不可用时退回 4 秒轮询。

## 五、部署到公网

1. **有公网 IP**：`docker compose up -d`，放行 8080，直接发 `http://IP:8080`。微信能打开 http，但复制按钮在 https 下更稳。
2. **反代 + 证书**（Nginx/Caddy），**SSE 必须关缓冲**：
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8080;
     proxy_http_version 1.1;
     proxy_set_header Connection '';
     proxy_buffering off;
     proxy_read_timeout 3600s;
   }
   ```
3. **Cloudflare Tunnel**（不开端口）：
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```

## 六、CI：自动构建镜像

`.github/workflows/docker.yml`：

- **test**：`node --check` + 起服务跑一遍接口冒烟（建房 → 身份码登录 → 错误码必须 403 → 同码重登成功），**测试挂了不出镜像**
- **docker**：buildx 构建 `linux/amd64` + `linux/arm64`，推到 GHCR
- 标签：`latest`（默认分支）、分支名、`v1.2.3` 版本号、`sha-xxxxxxx`；PR 只构建不推送
- 缓存用 GitHub Actions cache，二次构建快

发版：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 七、推荐是怎么算出来的

对每个候选城市：

- **平均距离 / 平均耗时**：到所有成员所在地的大圆距离；耗时按「高铁 230km/h + 站内换乘 0.8h，超过 1300km 改按飞机 750km/h + 2.2h」粗估，两端都是枢纽城市再扣一点
- **可达率**：估算耗时 ≤ 该成员自己填的「最长单程时间」的人数占比
- **得票**：多少人把它填进了「想去的地方」
- **景点分**：内置热度评分（3~5 分）
- **综合分** = 距离 40% + 得票 28% + 景点 16% + 可达率 16%（各项先归一化）

权重在 `index.html` 的 `computeStats()` 里一行，改数字即可。

> 只有两个人时，落在两点连线上的城市平均距离都一样，此时由景点分决定胜负——这是数学，不是 bug。凑到 6 人以上结论才稳。

## 八、文件与接口

```
index.html                    页面（内联 CSS/JS，含 110+ 城市与 26 个候选城市的景点）
server.js                     Node 服务：静态文件 + JSON API + SSE + SQLite
package.json                  启动脚本与 engines
Dockerfile                    node:24-alpine 镜像
docker-compose.yml            拉 GHCR 镜像
docker-compose.build.yml      本地构建覆盖
.github/workflows/docker.yml  测试 + 构建推送
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ping` | 健康检查，返回房间数 |
| POST | `/api/room` | 建房间 |
| GET | `/api/room/:id?token=` | 房间快照 + 我是谁 |
| POST | `/api/room/:id/join` | `{name, code}` 登录（首次即建号） |
| POST / DELETE | `/api/room/:id/member` | 改自己的资料 / 退出 |
| POST / DELETE | `/api/room/:id/thought` | 发想法 / 删自己的 |
| PUT | `/api/room/:id/meta` | 改群名、预期人数 |
| GET | `/api/room/:id/stream?token=` | SSE 实时推送 |

改城市库：`index.html` 里的 `CITY_RAW`，格式 `城市|省|纬度|经度|枢纽等级|最佳季节|景点分|标签|景点`（非候选城市只写前 5 项）。

## 九、为什么没做微信登录

微信的网站扫码登录要企业主体 + 300 元/年认证 + 已备案域名；公众号网页授权要认证服务号；小程序要备案提审。对 15 人的小群不划算。所以用「昵称 + 自己的身份码」，知道邀请链接就能进，进房间后用身份码区分彼此。

真要接微信登录，改动点很集中：把 `POST /api/room/:id/join` 换成「code 换 openid」，拿 openid 当 `members.id`，其余逻辑不动。

## License

MIT
