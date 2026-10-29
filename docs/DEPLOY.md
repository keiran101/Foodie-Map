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
| 平台进程 | systemd `foodmap.service` | `/usr/bin/node .../next start -H 0.0.0.0 -p 3000`，`Restart=always`、`SuccessExitStatus=143`；**版本化副本在 `scripts/foodmap.service`** |
| 数据库 | `127.0.0.1:5433` | 原生 systemd `postgresql`（**不是** docker），库 `foodie` |
| frps | `/root/frp_0.54.0_linux_amd64` | `bindPort=7000`，token 认证，`tls.force=true` |
| 内存 | 1608 MB + swap 4095 MB | 构建能过，但**只能单并发** |
| swap 策略 | `vm.swappiness = 0` | 写在 `/etc/sysctl.conf` 第 1 行（阿里云镜像默认）→ swap 基本用不上，见 §4 |
| Node | v20.20.2 / npm 10.8.2 | |
| Next | 16.3.0（Turbopack） | 构建实测 **16 秒**，不是分钟级 |
| 同机邻居 | `filed_rop-filedrop-1`（docker，1158 端口，占 42MB）、`AliYunDun` | 不是本项目，别顺手停 |

配置在 `/opt/foodmap/.env`（`chmod 600`），**不在 git 里，部署脚本也不传它**。

---

## 2. 标准流程

### 第 0 步：前置检查（30 秒）

```bash
# 服务器活着、平台在跑
curl -s -o /dev/null -w "%{http_code}\n" http://8.134.63.180:3000/discover   # 期望 200

# 只有改到 Agent 接入时才需要：本机 frpc + Agent 起着
curl -s -o /dev/null -w "%{http_code}\n" http://8.134.63.180:3001/.well-known/agent-card.json  # 期望 200

# 内存基线：available 低于 ~600MB 就先查是谁在吃（见 §4.4）
ssh root@8.134.63.180 "free -m | sed -n '2,3p'"
```

若 3001 是 502/000，先在本机跑 `ops\resident.cmd`，别急着部署平台——那会把两个故障混在一起。

### 第 1 步：本地过一遍

```bash
cd foodie-map
node_modules/.bin/tsc --noEmit -p tsconfig.json
```

只有一类错误可以放过：`@prisma/client` 相关的「找不到导出/属性」。原因是本地没跑 `prisma generate`，
服务器上有生成物，构建不受影响。其他错误一律修掉。

> 不要在本地跑 `next build` 然后把 `.next` 传上去 —— 见 §5 坑 1。

### 第 2 步：看差异

```bash
SRV_PW='<服务器密码>' python scripts/deploy.py --dry-run
```

输出会列出 `M`（改动）/ `A`（新增）/ `D`（服务器有、本地没有）。**先看这份清单**：

- 出现意料之外的文件 → 说明有人在服务器上手工改过代码，先搞清楚改了什么；
- 出现 `D` → 部署时会被**删除**，见 §5 坑 7；
- 预期 0 改动 → 别部署，说明你的改动没保存或不在 `src/ prisma/ public/ scripts/` 里。

### 第 3 步：部署

```bash
SRV_PW='<服务器密码>' python scripts/deploy.py
```

它做的事，顺序不能变：

1. md5 比对，只传差异文件（实测一次典型改动是 66 个文件里的 3 个）
2. **内存预检**：`available + 50MB` 要够 550MB，不够就拒绝构建（`--force` 越过）
3. `systemctl stop foodmap`，然后**必须看到 `inactive`** 才往下走 —— 停不掉就中止
4. `cp -a .next .next.bak` —— 留退路
5. `npm run build`（`NODE_OPTIONS=--max-old-space-size=1024`，全程采样内存峰值，
   结果写进 `/root/build.log` 的 `MEM_PEAK` 行）
6. 成功 → `systemctl start foodmap` → **等 `/discover` 真的返回 200**（最多 30 秒）
7. 构建失败 **或** 起不来 → 把 `.next.bak` 换回来并重启旧版本

**停机窗口实测约 30 秒**（构建 16s + 停 1s + 起 + 健康检查 4~10s）。
这 30 秒里正在跑的 SSE 长任务会断，见 §4.6。

> 关于「停服务腾内存」这句话：**别信**。实测 stop 之后 available 只从 796MB 涨到 849MB，
> 也就是 50MB 左右。停服是为了拿到 `.next` 的写入权，不是为了让出内存。详见 §4。


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

## 4. 停服与内存：1.6G 机器上「停掉」这件事

这台机器卖的是「便宜」，不是「富余」。部署的时候唯一必须停的东西是 `foodmap` 本身，
但**停错了对象、或者以为停了就能腾出内存**，是这里最容易踩的两个坑。

### 4.1 实测基线（2026-10-29 现场测的，不是估的）

| 指标 | 实测 |
|---|---|
| 总内存 / swap | 1608 MB / 4095 MB（`/swapfile`） |
| 部署前 `available` | 796 MB（`used` 627 / `buff/cache` 891） |
| `systemctl stop foodmap` 之后 | 849 MB —— **只多出 53 MB** |
| 构建期间 `MemAvailable` 最低点 | **385 ~ 390 MB**（两次独立实测） |
| 构建期间 swap 使用 | **0 MB** |
| 构建耗时 | 16 秒（Next 16 + Turbopack，`cpus: 1`） |
| 整段停机 | ~30 秒 |
| `next-server` RSS | 长跑 80 天后 145 MB；刚重启 100 MB |

三条结论，后面所有做法都是从这里推出来的：

1. **停服务不是腾内存的手段。** 只回 50MB。真正的余量来自「少干活」，不是「多停东西」。
2. **4G swap 不能算进可用内存。** `vm.swappiness = 0`（阿里云镜像默认写死），内核几乎不换出
   匿名页；实测构建全程 swap 一直是 0。也就是说可用内存掉到 385MB 时，**第二道缓冲并不存在**。
3. **停机窗口只有 30 秒**，不值得为「缩短窗口」做任何花活；但足够打断在跑的任务。

### 4.2 该停什么，不该停什么

| 对象 | 停不停 | 理由 |
|---|---|---|
| `foodmap` | **要停**（脚本自动做） | 不只是腾内存：构建要写 `.next`，正在跑的进程会读到半新半旧的产物，起来以后报各种莫名其妙的错 |
| `postgresql`（5433） | **别停** | 平台唯一的库（只有 `foodie`），停了平台全挂，而只省下 ~80MB |
| frps | **别停** | 3001 是 Agent 的唯一回程入口，断了 `/api/agent/*` 全挂。frpc 会自动重连，但重连窗口里 probe 是 502 |
| `filed_rop-filedrop-1`（docker） | **别顺手停** | 另一个项目的线上服务，占 42MB。真要腾内存才动它，且先跟那个项目确认 |
| `AliYunDun` / systemd 自身 | 别碰 | 安全组件，停了云控制台会告警 |
| docker 守护进程本身 | 别停 | `dockerd` + `containerd` 共 ~56MB，停了 `filed_rop` 一起走 |

一句话：**只有 `foodmap` 是你的，别的都是别人的。**

### 4.3 「停」的正确方式

```bash
systemctl stop foodmap
echo "STATE=$(systemctl is-active foodmap)"      # 期望 inactive
echo "PORT=$(ss -lntH 'sport = :3000' | wc -l)"  # 期望 0 ← 这个才是真判据
```

**判据是「3000 不再监听」，不是「状态叫 inactive」。** 这里有个真实的假象：

> Next 收到 SIGTERM 后以 **143**（128 + 15）退出，systemd 因此把这次 stop 记成
> `failed (Result: exit-code)`，`systemctl is-active` 输出的是 `failed` 而不是 `inactive`。
> 这不是停失败，是 unit 没声明「143 算正常退出」。

已经处理过两遍：

- unit 里加了 `SuccessExitStatus=143`（版本化副本在 `scripts/foodmap.service`，
  服务器上 `/etc/systemd/system/foodmap.service` 就是它）。**换 unit 要 `daemon-reload`。**
- `deploy.py` 认 `inactive` / `failed` 都算停成功，并且额外验一次 3000 端口 —
  状态和现实不一致时，以端口为准。

四条不要：

- **不要 `kill <pid>`。** unit 是 `Restart=always` + `RestartSec=3`，杀了它三秒后自己回来。
  你以为停了，其实内存没腾、构建还撞上它，最后 OOM 时被杀的是谁不好说。
- **不要 `kill -9`。** Next 需要优雅关闭（正在写的响应不会被硬切）。`systemctl stop`
  默认给 90 秒优雅期；实测 1 秒内就退了。真卡住了先 `systemctl status foodmap` 看它在等什么。
- **不要只看 `systemctl start` 的返回就以为好了。** 进程起来 ≠ 能服务。
  `systemctl is-active` 是绿的但页面 500，是 Next 部署里最常见的「看起来成功了」。
  所以脚本现在会去 `curl 127.0.0.1:3000/discover` 等到 200，等不到就回滚。
- **不要用 `systemctl restart` 代替 stop+build+start。** 构建期间服务在跑 = 内存双份占用，
  而且 `Restart=always` 会在构建中途把服务拉起来读半成品 `.next`。

> **停完就撒手，是这里出过的最严重一次事故**：脚本里「异常时把服务拉起来」的收尾钩子
> 注册在停服检查**之后**，于是检查失败那条 `sys.exit` 路径直接跳过了钩子，线上真的停了
> 两分钟。现在钩子注册在 `systemctl stop` 之前，且 `systemctl start` 对已运行的服务是 no-op，
> 所以任何退出路径（异常、Ctrl-C、Ctrl-Z + kill）都不会把站点留在停着的状态。
> **手工操作同理**：停之前先想好「谁来把它拉起来」。

### 4.4 内存不够时的处置顺序

按这个顺序，不要跳步：

1. **先看是不是有别的活在跑**：`ps aux --sort=-rss | head -10`、`docker stats --no-stream`
   —— 最常见的元凶是自己在服务器上开着的 `npm install`、`node`、`vim` 大文件。
2. **看 swap 到底有没有参与**：`free -m` 第三行、`vmstat 1 5` 的 `si/so`。
   一直是 0 就说明没有缓冲，别等它救命。
3. **真要腾**：`docker stop filed_rop-filedrop-1`（-42MB，需另一个项目确认）> 关掉自己的会话
   > 换机器。把 `NEXT_BUILD_CPUS` 调到 1 已经是默认值了，没有更省的下限。
4. **`--force` 只在明确知道后果时用**：它跳过预检，构建大概率被 OOM kill，
   而 OOM 挑谁杀是不可控的。

### 4.5 构建参数不要为了「快」调大

| 参数 | 现值 | 调大的后果 |
|---|---|---|
| `NEXT_BUILD_CPUS` | 1 | 2 就会顶穿内存（坑 2 的历史） |
| `NODE_OPTIONS=--max-old-space-size` | 1024 | 调到 2048 时，Node 会以为有 2G 可以用，实际机器只有 1.6G → 被内核杀，报错还看不出是内存问题 |

在 1.6G 上，「慢」是安全的表现。

### 4.6 停服会打断在跑的 Agent 任务

平台停机的那 30 秒里：

- 浏览器侧的 SSE 连接断掉，`/api/agent/build` 的流直接结束，前端看到的是失败；
- 本机 Agent **不会**跟着停（它在你的工作站上），pi/python 会继续跑；
  但它回写平台 API 的请求会在这 30 秒里失败（ECONNREFUSED / 502）。
  任务 token 是 JWT、验签不依赖进程状态，所以平台回来之后 token 本身仍然有效，
  不会出现「token 失效」的二次故障。

**做法**：部署前确认没有在跑的建合集任务。查法很土但有效 ——
看 Agent 日志里最近有没有任务、或者干脆等手上那个跑完再部署。
不要在用户点完「生成合集」的瞬间部署。

### 4.7 OOM 怎么认

| 现象 | 含义 |
|---|---|
| `deploy.py` 报 `EXIT=137` | 137 = 128 + 9(SIGKILL)，**基本就是被 OOM killer 杀的** |
| `/root/build.log` 最后没有 `EXIT=` 行 | 构建进程在写结果之前就没了 |
| `MEM_PEAK ... MemAvailable_min=…` 后一行没有 `EXIT=0` | 被杀点就在这个水位 |
| 别的服务莫名消失（python / dockerd） | 内存不够时内核挑了别人，比构建失败更难查 |

查证据（**重启后窗口内的证据会滚掉，要当场看**）：

```bash
dmesg -T | grep -i -E 'killed process|out of memory' | tail
journalctl -k --since '1 hour ago' | grep -i -E 'oom|killed process'
```

`/var/log/journal` 是持久化的（当前 449MB，`/` 还有 21G，暂时不用清），
但 `dmesg` 的环形缓冲区会被刷掉。

---

## 5. 坑位清单


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
ssh root@8.134.63.180 "systemctl is-active foodmap; grep MEM_PEAK /root/build.log; tail -30 /root/build.log"
```

两种失败要分开看：

| 日志里的最后一行 | 含义 | 下一步 |
|---|---|---|
| `EXIT=137` | 被 OOM killer 杀了（128+9） | 见 §4 / §4.7 |
| `EXIT=1` 且有 TS / ESLint 输出 | 代码问题 | 修完再部署 |
| `EXIT=0` 但脚本说「起不来」 | 构建没问题，是运行时起不来 | 看 `journalctl -u foodmap -n 30` |

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

**已自动化**：`scripts/deploy.py` 只在真的上传了新的 `prisma/schema.prisma` 时才执行
`prisma db push --skip-generate`，失败就中止部署（服务留在旧版本上）；
`/root/deploy-build.sh` 在 `next build` 之前无条件跑一次 `prisma generate`。
上面这两条手写命令只在**手工部署**时才需要。

**刻意不加 `--accept-data-loss`**：万一某次变更是删列/删表，脚本会在 db push 这步失败退出，
不会替人决定丢掉生产数据。真要删，人工上服务器做，并先备份。

---

### 坑 9｜内存只有 1.6G，构建时别并发干别的

构建 + 你另开的重活（比如同时在服务器上跑 `npm install`）会抢同一份 1.6G。
「4G swap 是兜底」这句话在这里**不成立**（`swappiness=0`，实测构建时 swap 用量 0），
所以别指望它接住。构建期间不要在同一台机器上做重操作。

停服、腾内存、OOM 怎么认，全部展开在 §4，这里不重复。

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

## 6. 回滚

| 场景 | 做法 |
|---|---|
| 构建失败（`EXIT≠0`，常见 137=OOM） | 自动回滚，无需操作（确认 `systemctl is-active foodmap`） |
| 构建成功但服务起不来（脚本已等到 `/discover` 超时） | 自动回滚，同上 |
| 构建成功、健康检查也过，但功能坏了 | 手工换回上一版产物：`cd /opt/foodmap && systemctl stop foodmap && rm -rf .next && mv .next.bak .next && systemctl start foodmap` |
| 需要退回更早的代码 | 本地 `git checkout <旧 commit>` → 再跑一次 `deploy.py`（会重新构建） |

注意 `.next.bak` 只保留**上一次**构建前的产物，多次部署后就被覆盖了。
自动回滚会**消耗** `.next.bak`（它是 `mv` 不是 `cp`），所以回滚完就没有第二份了。

---

## 7. 手工部署（脚本不可用时）

```bash
# 1. 本机：传文件（示例：只传改动的几个）
sftp root@8.134.63.180 <<'EOF'
put src/lib/agent.ts /opt/foodmap/src/lib/agent.ts
EOF

# 2. 服务器：看内存 → 备份 → 停服 → 构建 → 起 → 验活
ssh root@8.134.63.180 '
  free -m | sed -n "2p" && \
  cd /opt/foodmap && \
  rm -rf .next.bak && cp -a .next .next.bak && \
  systemctl stop foodmap && systemctl is-active foodmap; \
  NODE_OPTIONS=--max-old-space-size=1024 npm run build; \
  systemctl start foodmap; sleep 5; \
  curl -s -o /dev/null -w "discover=%{http_code}\n" http://127.0.0.1:3000/discover'
```

**手工做就少了「只传差异」「内存预检」「失败自动回滚」，风险更高**，能用脚本就用脚本。
注意 `systemctl is-active` 在 inactive 时返回码是 3，接在 `&&` 链里会让后面的构建**不执行**
（上面故意用了 `;` 断开，别改成 `&&`）。

---

## 8. 上线检查清单

- [ ] 本地 `tsc --noEmit` 无新增错误
- [ ] `deploy.py --dry-run` 的差异符合预期，没有意外的 `D`
- [ ] 新版 `.env` 里的键都写进了 `.env.example`
- [ ] **没有在跑的建合集任务**（停服 30 秒会打断它，见 §4.6）
- [ ] 服务器上没有自己开的 `npm install` / 大编译在跑（§4.4）
- [ ] 部署时脚本打印了「状态 inactive/failed，3000 监听数 0」（§4.3）
- [ ] 部署日志里的 `MEM_PEAK MemAvailable_min=` 没低到离谱（正常 385~390MB）
- [ ] `EXIT=0` 而不是 `EXIT=137`
- [ ] 部署后 `systemctl is-active foodmap` = active
- [ ] `/discover` 返回 200（脚本已自动验，手工部署要自己验）
- [ ] 新路由出现在 `/root/build.log` 的路由表里
- [ ] 改了 Agent 接入 → `python scripts/smoke-agent.py --skip-build` 返回 `connected:true`
- [ ] `python scripts/smoke-agent.py` 退出码 0（`citySource` / `added` / `ownerId` 全过）
- [ ] 代码已提交
