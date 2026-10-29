# 平台改动上线指导

> 面向：改了 `foodie-map`（平台）代码，要把它弄到线上 `http://8.134.63.180:3000` 的人。
> 不适合：改 Agent（`foodie-map-agent`）—— 那个不在服务器上跑，见本文 §0。

---

## 0. 先分清两个部署对象

这是最容易搞混的一件事，搞混了会在服务器上装错东西。

| | 平台 `foodie-map` | Agent `foodie-map-agent` |
|---|---|---|
| 跑在哪 | **云服务器** 8.134.63.180 | **你自己的工作站**（会关机的那台） |
| 怎么起 | systemd `foodmap.service` | `ops/resident.cmd` 守护，监听 7801 |
| 怎么更新 | 本文 §2 | 改完重启本机服务，**不碰服务器** |
| 对外入口 | 3000 | 本机 7801 → frpc → 服务器 frps:3001 |

线上拓扑：

```
浏览器 ──> 8.134.63.180:3000   平台 Next.js (systemd)
                │
                │ 调用 Agent（AGENT_A2A_BASE_URL）
                ▼
          127.0.0.1:3001  ← frps 在该机器上开的监听口
                ║
                ║ frp 隧道（frpc 主动连出去，所以内网不需要公网 IP）
                ▼
          工作站 7801  ← Agent（pi + python 能力层）
```

**方向别搞反**：服务器上只有 **frps**（`/root/frp_0.54.0_linux_amd64`，监听 7000）。
frpc 只在你的工作站。在服务器上装 frpc 是错的。

---

## 1. 线上是什么样（实测记录，不是推测）

| 组件 | 位置 | 形态 |
|---|---|---|
| 平台代码 | `/opt/foodmap` | **不是 git 仓库**（历史部署是整目录拷的） |
| 平台进程 | systemd `foodmap.service` | `/usr/bin/node .../next start -H 0.0.0.0 -p 3000`，`Restart=always` |
| 数据库 | `127.0.0.1:5433` | 原生 systemd `postgresql`（**不是** docker），库 `foodie` |
| frps | `/root/frp_0.54.0_linux_amd64` | `bindPort=7000`，token 认证，`tls.force=true` |
| 内存 | 1608 MB + swap 4095 MB | 构建能过，但**只能单并发** |
| Node | v20.20.2 / npm 10.8.2 | |

配置在 `/opt/foodmap/.env`（`chmod 600`），**不在 git 里，部署脚本也不传它**。

---

## 2. 标准流程

### 第 0 步：前置检查（30 秒）

```bash
# 服务器活着、平台在跑
curl -s -o /dev/null -w "%{http_code}\n" http://8.134.63.180:3000/discover   # 期望 200

# 只有改到 Agent 接入时才需要：本机 frpc + Agent 起着
curl -s -o /dev/null -w "%{http_code}\n" http://8.134.63.180:3001/.well-known/agent-card.json  # 期望 200
```

若 3001 是 502/000，先在本机跑 `ops\resident.cmd`，别急着部署平台——那会把两个故障混在一起。

### 第 1 步：本地过一遍

```bash
cd foodie-map
node_modules/.bin/tsc --noEmit -p tsconfig.json
```

只有一类错误可以放过：`@prisma/client` 相关的「找不到导出/属性」。原因是本地没跑 `prisma generate`，
服务器上有生成物，构建不受影响。其他错误一律修掉。

> 不要在本地跑 `next build` 然后把 `.next` 传上去 —— 见 §4 坑 1。

### 第 2 步：看差异

```bash
SRV_PW='<服务器密码>' python scripts/deploy.py --dry-run
```

输出会列出 `M`（改动）/ `A`（新增）/ `D`（服务器有、本地没有）。**先看这份清单**：

- 出现意料之外的文件 → 说明有人在服务器上手工改过代码，先搞清楚改了什么；
- 出现 `D` → 部署时会被**删除**，见 §4 坑 7；
- 预期 0 改动 → 别部署，说明你的改动没保存或不在 `src/ prisma/ public/ scripts/` 里。

### 第 3 步：部署

```bash
SRV_PW='<服务器密码>' python scripts/deploy.py
```

它做的事，顺序不能变：

1. md5 比对，只传差异文件（实测一次典型改动是 66 个文件里的 3 个）
2. `systemctl stop foodmap` —— 腾内存
3. `cp -a .next .next.bak` —— 留退路
4. `npm run build`（`NODE_OPTIONS=--max-old-space-size=1024`，日志 `/root/build.log`）
5. 成功 → `systemctl start foodmap`；**失败 → 把 `.next.bak` 换回来并重启旧版本**

**这一步有停机窗口，约 1～2 分钟**（构建本身 60～90 秒 + 启停）。构建期间正在跑的 SSE 长任务会断。

### 第 4 步：验证

```bash
# 平台活着
curl -s -o /dev/null -w "%{http_code}\n" http://8.134.63.180:3000/discover

# 新路由编译进去了（部署脚本会打印，也可以自己看）
ssh root@8.134.63.180 "grep -E 'api/agent' /root/build.log"
```

改到 Agent 接入时，用冒烟脚本。它**先探针、再任务**，顺序是刻意的 ——
排查时最先要区分的是「穿透/凭据不通」还是「任务跑挂了」，混在一起会一上来就跑十分钟的活：

```bash
python scripts/smoke-agent.py --skip-build   # 只探针（秒级）
python scripts/smoke-agent.py                # 探针 + 真跑一条建合集任务
```

身份来源按顺序尝试：`FOODMAP_TOKEN` → CLI 登录态（`~/.foodmap-cli.json`，自动续期）
→ `FOODMAP_EMAIL` / `FOODMAP_PASSWORD`。退出码 `0` 通过 / `1` 探针不通 / `2` 任务未完成。

想手工看也可以：

```bash
TOKEN=<accessToken>
curl -s -H "authorization: Bearer $TOKEN" http://8.134.63.180:3000/api/agent/probe
# 期望 {"configured":true,"connected":true,"card":{"version":"0.2.0","streaming":true}}

curl -N -X POST http://8.134.63.180:3000/api/agent/build \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"source":"把这两家店做成合集：深圳福田区八卦一路的豪先生、深圳南山区海岸城的海底捞","city":"深圳","visibility":"UNLISTED"}'
# 期望逐步 data: {"type":"progress"...}，最后 data: {"type":"done","state":"completed"...}
```

验收标准不是「有返回」，而是：`citySource=platform`、`added` 符合预期、
合集 `ownerId` 等于调用方用户、`/maps/<id>` 返回 200。这几条冒烟脚本都会校验。

### 第 5 步：收尾

- 提交代码（服务器没有 git，**仓库是唯一的历史**）
- 若这次动了 `.env`，确认写进 `.env.example`（否则下一个人不知道要配什么）
- 若构建失败触发了回滚，先看 `/root/build.log` 再决定下一步

---

## 3. 环境变量

改 `/opt/foodmap/.env`，然后 `systemctl restart foodmap`。但注意最后一列：

| 变量 | 作用 | 改了怎么生效 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（线上端口 **5433**） | restart |
| `JWT_SECRET` / `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | 登录凭证 | restart（改 SECRET 会让所有人掉登录） |
| `JWT_TASK_TTL` | 任务级 token 有效期，默认 `45m` | restart |
| `AMAP_WEB_KEY` | 高德服务端 REST Key | restart |
| `DEFAULT_CITY` | 店名缺城市时的兜底城市 | restart |
| `AGENT_A2A_BASE_URL` | Agent 地址。**平台与 frps 同机，填 `http://127.0.0.1:3001`** | restart |
| `AGENT_A2A_TOKEN` | 与 Agent 侧 `FOODIE_A2A_TOKEN` 同值 | restart |
| `AGENT_STREAM_TIMEOUT_MS` | 单任务流式上限，默认 12 分钟 | restart |
| `NEXT_BUILD_CPUS` | 构建并发，默认 1 | **重新构建** |
| `NEXT_PUBLIC_*`（高德 JS Key / 安全密钥 / BASE_URL） | 前端可见配置 | **重新构建**（见坑 3） |

---

## 4. 坑位清单

### 坑 1｜不要本地构建再上传 `.next`

**症状**：构建在这台 Windows 上能过，传到服务器后 `next start` 起不来，
或报找不到 `libquery_engine-*.node`。

**根因**：Prisma 的查询引擎是**按平台**生成的原生二进制，`node_modules/.prisma/client`
里只有构建机的版本。本地 Windows 构建出来的产物会去要 Windows 的引擎。

**做法**：构建一律在服务器上做（`deploy.py` 已经这么实现）。

---

### 坑 2｜`experimental.cpus` 必须为 1

**症状**：服务器构建被 OOM kill，`/root/build.log` 里出现 `Killed` 或直接没有收尾输出。

**根因**：1.6G 内存，Next 多进程构建顶不住。

**做法**：`NEXT_BUILD_CPUS` 默认就是 1，别为了「快一点」调到 2。
这个值曾经**只在服务器上手工改过、本地仓库还写着 2** —— 属于「热修没回仓」，
下一次部署就会把它改回去然后构建失败。现在由环境变量控制，别再手改文件。

---

### 坑 3｜`NEXT_PUBLIC_*` 改了必须重建

**症状**：改了高德 Key / BASE_URL，`systemctl restart` 之后线上毫无变化。

**根因**：`NEXT_PUBLIC_` 前缀的变量在**构建期**被内联进前端产物，不是运行时读的。

**做法**：改这类变量 ⇒ 必须重新 `next build`。改了却没重建，是最隐蔽的「改了没生效」。

---

### 坑 4｜`.env.example` 曾被 `.gitignore` 吃掉

**症状**：仓库里看不到要配哪些环境变量。

**根因**：`.gitignore` 里 `.env*` 把 `.env.example` 一起匹配了。

**做法**：已加 `!.env.example` 例外。新增配置项时**同时更新它**。

---

### 坑 5｜`.env` 里的值不要加引号（跨 Windows 场景）

**症状**：某个 key 明明配了，运行时却报未授权；错误信息完全不指向配置。

**根因**：`bash source` 会剥掉 `KEY="value"` 的引号，`cmd.exe` **不会**，
于是子进程拿到的是带引号的字符串（长度多 2）。同一个 `.env` 被两种方式读就会分叉。

**做法**：读端统一剥引号；`.env` 里尽量不写引号。

---

### 坑 6｜构建失败会自动回滚，但要确认

**症状**：部署命令报了失败，不确定线上是不是还活着。

**做法**：脚本会自动 `mv .next.bak .next` 并重启旧版本。仍然要自己确认：

```bash
ssh root@8.134.63.180 "systemctl is-active foodmap; tail -30 /root/build.log"
```

失败原因绝大多数是：TS 类型错误、`ESLint` 阻断、缺依赖（改了 `package.json` 但没 `npm install`）。

---

### 坑 7｜部署会删掉服务器上「本地没有」的文件

**症状**：服务器上手改过的小补丁消失了。

**根因**：`deploy.py` 对 `src/ prisma/ public/ scripts/` 下「服务器有、本地没有」的文件
执行删除，否则旧文件会残留。

**做法**：不要在服务器上直接改代码。真要热修，先把它**带回仓库**。
（坑 2 就是这么埋下的。）

---

### 坑 8｜数据库 schema 变更：生产库是 `db push` 建的

**症状**：`npx prisma migrate status` 报 `20260806104305_init` 未应用，但表其实早就存在；
执行 `migrate deploy` 会试图从零建表而失败。

**根因**：线上库是用 `prisma db push` 推的，`_prisma_migrations` 表是空的，
迁移账本和实际状态不一致。

**做法**（二选一，别混用）：

```bash
# A. 沿用现状：直接推 schema（与历史一致，风险最低）
cd /opt/foodmap && npx prisma db push && systemctl restart foodmap

# B. 补账本：先把现状标记为已应用，之后才能用 migrate deploy
npx prisma migrate resolve --applied 20260806104305_init
```

改 schema 后还要 `npx prisma generate`，否则 TS 类型对不上。

---

### 坑 9｜内存只有 1.6G，构建时别并发干别的

构建 + 现有服务 + 你另开的重活（比如同时在服务器上跑 `npm install`）会一起进 swap。
4G swap 是兜底，不是余量。构建期间别在服务器上做别的重操作。

---

### 坑 10｜服务器不是 git 仓库

不要 `git pull`。`/opt/foodmap` 没有 `.git`，同步只靠 `deploy.py`。
也正因为如此：**仓库是唯一的历史**，线上代码没有版本可回退，只能重新部署旧 commit。

---

### 坑 11｜3001 打不通时先分清是谁的问题

| 现象 | 判断 |
|---|---|
| `curl 127.0.0.1:3001` 在服务器上直接拒绝 | frps 上没注册这个代理 → 本机 frpc 没连上 |
| 服务器 3001 有监听但返回 502 | frpc 连上了，但它背后 7801 没起 |
| 本机 7801 没监听 | Agent 没起 → 跑 `ops\resident.cmd` |

`probe` 端点会把 `baseUrl` 打出来，先确认它是不是 `http://127.0.0.1:3001`。

---

### 坑 12｜凭据不落盘

`deploy.py` 只从环境变量 `SRV_PW` 读密码，不写文件、不进仓库。
在 shell 里用 `SRV_PW='...' python scripts/deploy.py` 这种一次性前缀，别 `export` 到 `.bashrc`。

---

## 5. 回滚

| 场景 | 做法 |
|---|---|
| 构建失败 | 自动回滚，无需操作（确认 `systemctl is-active foodmap`） |
| 构建成功但功能坏了 | 手工换回上一版产物：`cd /opt/foodmap && systemctl stop foodmap && rm -rf .next && mv .next.bak .next && systemctl start foodmap` |
| 需要退回更早的代码 | 本地 `git checkout <旧 commit>` → 再跑一次 `deploy.py`（会重新构建） |

注意 `.next.bak` 只保留**上一次**构建前的产物，多次部署后就被覆盖了。

---

## 6. 手工部署（脚本不可用时）

```bash
# 1. 本机：传文件（示例：只传改动的几个）
sftp root@8.134.63.180 <<'EOF'
put src/lib/agent.ts /opt/foodmap/src/lib/agent.ts
EOF

# 2. 服务器：备份 + 构建
ssh root@8.134.63.180 '
  cd /opt/foodmap && systemctl stop foodmap && \
  rm -rf .next.bak && cp -a .next .next.bak && \
  NODE_OPTIONS=--max-old-space-size=1024 npm run build 2>&1 | tail -20 && \
  systemctl start foodmap && systemctl is-active foodmap'
```

**手工做就少了「只传差异」和「失败自动回滚」，风险更高**，能用脚本就用脚本。

---

## 7. 上线检查清单

- [ ] 本地 `tsc --noEmit` 无新增错误
- [ ] `deploy.py --dry-run` 的差异符合预期，没有意外的 `D`
- [ ] 新版 `.env` 里的键都写进了 `.env.example`
- [ ] 部署后 `systemctl is-active foodmap` = active
- [ ] `/discover` 返回 200
- [ ] 新路由出现在 `/root/build.log` 的路由表里
- [ ] 改了 Agent 接入 → `python scripts/smoke-agent.py --skip-build` 返回 `connected:true`
- [ ] `python scripts/smoke-agent.py` 退出码 0（`citySource` / `added` / `ownerId` 全过）
- [ ] 代码已提交
