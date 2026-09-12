# 🗺️ foodie-map · 美食探店地图

> 把店铺清单一键生成可导航的美食探店合集地图。

🔗 **在线体验**：<http://8.134.63.180:3000>

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](#license)

---

## 📖 这是什么

foodie-map 是一个面向「探店爱好者 / 内容创作者 / Agent」的美食地图工具。核心场景：你手头有一堆店名（来自探店视频、评论区、备忘录），想把它们快速变成一张**能在地图上查看、能一键导航、能分享给他人**的美食合集。

传统做法要一家家查坐标、手标点地图；foodie-map 让这件事自动化：

```
店名列表 + 城市  →  自动高德搜索补全坐标  →  生成可导航合集  →  分享链接
```

**差异化亮点**

- 内置 **Agent 聚合接口**（`POST /api/collections/generate`）：外部智能体（如 WorkBuddy）从视频/内容里识别出店名后，一次请求即可建成合集并返回可分享链接。
- 配套 **CLI 工具**：任意 Agent 通过一行命令把店铺灌入系统，适合接入自动化工作流。

---

## ✨ 功能特性

- **美食合集（FoodMap）**：创建 / 编辑 / 删除，支持封面图、城市、可见性（公开 / 未公开 / 私有）。
- **店铺管理（Place）**：名称、坐标、地址、分类、人均、电话、评分、备注、排序。
- **地图与导航**：高德地图可视化渲染；一键唤起 **高德 / 百度 / 腾讯** 三家导航。
- **社交互动**：点赞 / 点踩、收藏、评论、关注创作者、Fork（复制）他人地图。
- **视频探店**：`SourceVideo` 解析流水线（待解析 → 处理中 → 完成 / 失败），从探店内容沉淀店铺数据。
- **用户系统**：邮箱注册 / 登录，JWT 鉴权（`accessToken` 15 分钟 + `refreshToken` 自动续期）。
- **Agent 友好**：开放建合集 API + 官方 CLI，便于接入自动化脚本与智能体。

---

## 🛠 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 16（App Router）、React 19、Tailwind CSS 4、TypeScript |
| 后端 | Next.js Route Handlers（API routes） |
| 数据库 | PostgreSQL 16 + Prisma 6（ORM） |
| 鉴权 | bcryptjs + jsonwebtoken + zod |
| 地图 | 高德地图 JS API |

---

## 📸 界面预览

| 合集详情页 | 店铺列表与导航 |
| --- | --- |
| <img src="docs/screenshots/map-detail.jpg" alt="合集地图详情页" width="280"> | <img src="docs/screenshots/place-list.jpg" alt="店铺列表与导航" width="280"> |

> 左：一键生成的「深圳南山 · 罗湖 · 龙华 5 家美食合集」，高德地图自动标注全部店铺，支持点赞 / 收藏 / 评论 / 复制为我的合集。右：每家店铺带「导航」按钮，一键唤起高德 / 百度 / 腾讯地图。

---

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20
- PostgreSQL（本地可用下方 Docker Compose 一键起）
- 高德地图 Web 端 Key（JS API Key + 安全密钥）

### 安装与运行

```bash
git clone https://github.com/keiran101/Foodie-Map.git
cd Foodie-Map
npm install

# 配置环境变量（见下方「环境变量」）
cp .env.example .env     # 如仓库未提供 .env.example，请手动创建 .env
npx prisma migrate dev
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000) 即可使用。

### 环境变量

| 变量 | 必填 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串（本地示例见下） | - |
| `JWT_SECRET` | 是 | JWT 签名密钥，**生产环境务必修改** | `dev-secret-change-me` |
| `AMAP_WEB_KEY` | 是 | 服务端高德 Key（坐标搜索补全） | - |
| `NEXT_PUBLIC_AMAP_JS_KEY` | 是 | 前端高德 JS API Key | - |
| `NEXT_PUBLIC_AMAP_SECURITY_CODE` | 是 | 高德 JS API 安全密钥 | - |
| `DEFAULT_CITY` | 否 | 店名缺城市时坐标搜索的默认城市 | `成都` |
| `NEXT_PUBLIC_BASE_URL` | 否 | 生成合集链接时的站点基址 | 空（回退为请求 host） |
| `JWT_ACCESS_TTL` | 否 | `accessToken` 有效期 | `15m` |
| `JWT_REFRESH_TTL` | 否 | `refreshToken` 有效期 | `7d` |

> 本地数据库示例：`postgresql://foodie:foodie@localhost:5432/foodie`（与 `docker-compose.yml` 中 `foodie-postgres` 容器一致）。

---

## 🐳 部署

提供 Docker Compose（PostgreSQL）与统一启动入口：

```bash
# 1. 启动数据库（docker-compose 内含 foodie-postgres 容器）
docker compose up -d

# 2. 统一启动入口：未运行则拉起 next server
python main.py
```

- **依赖前置**：Node.js、`npm install`、PostgreSQL（16）。
- **Windows 开机自启**：`scripts/start-foodmap.cmd` 放入用户「启动」文件夹，登录时自动运行 `python main.py`；亦可用 PowerShell 变体 `scripts/start-foodmap.ps1`。
- **排障**：网页打不开时，先确认 PostgreSQL（5432）在运行，再执行 `python main.py`。

> ⚠️ 当前演示服务（`http://8.134.63.180:3000`）为 **HTTP 明文传输**，请勿在其中存放真实敏感凭证；生产部署请在前端加 HTTPS 反向代理（如 Nginx / Caddy）。

---

## 🤖 Agent / API 集成（一键建合集）

foodie-map 的核心差异化能力：让外部 Agent 把识别到的店名一键建成合集。

### 方式一：CLI（推荐给 Agent 管道）

```bash
# 登录（凭证存 ~/.foodmap-cli.json，token 过期自动续期）
node scripts/foodmap.mjs login <email> <password> [--base http://8.134.63.180:3000]

# 从 JSON 文件创建合集
node scripts/foodmap.mjs create places.json

# 或从 stdin 传入（适合 Agent 管道）
echo '{"title":"视频探店合集","city":"成都","places":[{"name":"蜀大侠火锅"}]}' \
  | node scripts/foodmap.mjs create -

# 查看登录状态
node scripts/foodmap.mjs whoami
```

`places.json` 格式（店名必填；缺坐标会自动用高德搜索补全）：

```json
{
  "title": "周末成都火锅巡礼",
  "city": "成都",
  "description": "从探店视频整理",
  "visibility": "PUBLIC",
  "places": [
    { "name": "蜀大侠火锅" },
    { "name": "小龙坎", "lng": 104.07, "lat": 30.66 }
  ]
}
```

- 默认服务地址 `http://127.0.0.1:3000`，可用 `--base` 或环境变量 `FOODMAP_BASE` 覆盖。
- 高德搜不到的店会跳过并在输出中列出，可手动补 `lng/lat` 后重试。

### 方式二：直接调用聚合接口

```http
POST /api/collections/generate
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "title": "周末深圳火锅巡礼",
  "city": "深圳",
  "places": [
    { "name": "蜀大侠火锅" },
    { "name": "周记肠粉王", "city": "深圳" }
  ]
}
```

成功响应（201）：

```json
{
  "mapId": "cm...",
  "url": "http://8.134.63.180:3000/maps/cm...",
  "added": 2,
  "missing": [],
  "visibility": "PUBLIC"
}
```

`url` 即合集页面链接，可直接发给用户。

> ⚠️ **城市很重要**：店名缺坐标时服务端用高德自动补全，必须提供 `city`（顶层或每家店的 `city` 字段），否则可能匹配到错误城市的同名店。

完整接口（注册 / 登录 / 坐标搜索 / 浏览合集）见仓库内置 `public/api-docs.html` 与机器可读的 `public/llms.txt`。

---

## 📂 目录结构

```
foodie-map/
├── src/
│   ├── app/                 # Next.js App Router（页面 + API routes）
│   │   ├── api/             # 后端接口：auth / maps / places / collections / geo / search ...
│   │   ├── maps/            # 合集详情、新建页
│   │   ├── discover/        # 发现页
│   │   ├── search/          # 搜索页
│   │   ├── login|register/  # 登录 / 注册
│   │   └── me/              # 个人中心
│   ├── components/          # Header / MapCanvas / PlaceCard / 编辑弹窗 / 导航弹窗 ...
│   └── lib/                 # amap、auth、prisma、api-helpers、校验等工具
├── scripts/
│   └── foodmap.mjs          # Agent 一键建合集 CLI
├── prisma/
│   └── schema.prisma        # 数据模型（User / FoodMap / Place / Collection / SourceVideo ...）
├── docker-compose.yml       # PostgreSQL（容器 foodie-postgres）
├── main.py                  # 统一启动入口
├── public/                  # api-docs.html / llms.txt / 静态资源
└── README.md
```

---

## 🗄 数据模型概览

核心实体（详见 `prisma/schema.prisma`）：

- **User**：邮箱 / 密码（bcrypt 哈希）、昵称、是否创作者、社交关系（关注 / 粉丝）。
- **FoodMap**：美食合集，含标题、城市、封面、可见性、浏览数。
- **Place**：合集下的店铺，含坐标、地址、分类、人均、电话、评分、备注、排序。
- **Collection**：轻量店铺合集，与 `FoodMap` 关联。
- **SourceVideo**：探店视频源，含解析状态机（`PENDING` / `PROCESSING` / `DONE` / `FAILED`）。
- **NavLog / MapLike / MapDislike / Favorite / Comment / Follow / MapFork**：导航日志、点赞、点踩、收藏、评论、关注、复制。

---

## 📄 License

[MIT](LICENSE) © foodie-map
