# 桌游活动组织 Web App

首页创建活动，参与者通过链接或 8 位活动码进入，填写姓名或微信名即可报名。没有注册、密码、微信身份或头像。

后端使用 TypeScript、Fastify 和 PostgreSQL。默认以 PGlite 在本地运行嵌入式 PostgreSQL，数据保存在项目目录；正式部署可切换到外部 PostgreSQL。前端是直接调用 API 的 HTML、CSS 和原生 JavaScript。

## 本地启动

需要 Node.js 22 或更新版本。请在项目根目录执行：

```powershell
npm install
npm start
```

打开 [http://localhost:3000](http://localhost:3000)。首次启动自动执行 `migrations/` 中的数据库迁移；默认不需要安装 Docker 或 PostgreSQL。

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动应用及内置周期任务 |
| `npm run dev` | 监听源码变化并重启 |
| `npm test` | 运行算法和 API/数据库测试 |
| `npm run check` | TypeScript 类型检查 |
| `npm run build` | 编译到 `dist/` |
| `npm run start:production` | 运行编译后的应用，仍需保留 `public/` 和 `migrations/` |
| `npm run db:migrate` | 手动执行未应用的迁移 |
| `npm run worker` | 外部 PostgreSQL 模式的独立周期任务进程 |

`npm run start:production` 是运行编译代码的命令，不会自动设置 `NODE_ENV`。生产配置须显式设置环境变量。

## 使用流程

1. 在首页填写姓名、活动名称、地点、开始和结束时间，创建活动。
2. 保存创建后展示的管理恢复密钥；复制普通活动链接或活动码发给参与者。
3. 参与者通过链接或首页输入活动码进入，填写姓名或微信名后选择桌游；也可自己开桌成为 host。
4. 未满的桌直接入席；满员进入候补。入席成员退出时，队首候补自动补位。
5. 开始前 24 小时截止，系统将候补分配到当前人数最少且未满的桌，展示最终结果。

同一站点可以同时创建多场活动，每场有独立 owner、管理员、成员和报名数据。

## 免登录身份与管理密钥

浏览器保存名为 `bg_session` 的 HttpOnly 匿名 Cookie，服务端只存储令牌哈希。内部 participant ID 和姓名都不能替代该凭证。活动内同名会提示冲突，可以加入可辨认的后缀；同名不会获得他人的报名或管理权限。

同一浏览器返回时可继续管理自己的报名；清除站点数据、使用无痕窗口、换浏览器或设备会失去原普通报名的编辑凭证。匿名方案不能证明多个浏览器是否属于同一真实的人，不能阻止同一人换名字重新参与。

创建者自动成为该活动 owner。**管理恢复密钥只在生成时展示，应单独保存，不随普通链接或活动码分享。** 在活动页面输入密钥可恢复该活动 owner 的操作权限，包括其在该活动中的桌游和报名；不会获得其他活动的权限。

owner 可以任免管理员、转让 owner 或轮换管理密钥。转让后原 owner 降为管理员，旧密钥及该活动的已恢复授权失效；新 owner 应在自己的浏览器生成并保存新密钥。轮换密钥会撤销其他通过旧密钥恢复的浏览器。

普通活动链接和活动码允许查看活动信息、显示名和名单，不包含管理权限。它们是可分享的入口，应发给预期参与者；应用不提供全站活动列表。

## 活动规则

- 创建或在报名期修改活动时，开始时间须严格晚于当前时间加 24 小时；结束晚于开始，单次最长 3 天。
- 每位系统识别的活动成员只有一个主选桌。开桌自动占用 host 的报名与一个席位，容量 1–100 且包含 host。
- 换桌需先退出；host 需删除自己的桌，不能普通退出。删桌释放该桌全部报名和候补。
- 扩容自动补位；缩容不得低于当前入席人数。只有 host 可以编辑或删除自己的桌，管理员身份不会覆盖此规则。
- 截止后冻结桌游与报名，保留已入席者，仅重新分配候补。候补顺序与同人数选桌使用稳定随机 seed；无空位者显示为未分配。
- 已结算活动可由 owner/admin 更正展示信息，结果不重新计算，报名不重新开放。
- 时间以 UTC 存储，活动时区用于输入和展示；默认 `America/Chicago`。截止与清理按实际经过的 24 小时计算。
- 结束 24 小时后，周期任务删除活动、桌游、活动成员和报名，不保存历史。删除不会影响其他活动。任务每 5 分钟检查一次，因此实际清理可能稍有延迟。

## 配置

默认配置直接支持本地启动。需要自定义时，可将 `.env.example` 复制为 `.env` 后修改；应用会自动加载根目录的 `.env`，已设置的进程环境变量优先。

```powershell
Copy-Item .env.example .env
```

PowerShell 示例：

```powershell
$env:PORT = '3001'
$env:PUBLIC_ORIGIN = 'http://localhost:3001'
npm start
```

| 环境变量 | 默认值 / 说明 |
| --- | --- |
| `HOST` | `127.0.0.1`；容器中通常设置 `0.0.0.0` |
| `PORT` | `3000` |
| `PUBLIC_ORIGIN` | 显式值优先；未设置时使用 Render 的 `RENDER_EXTERNAL_URL`，本地默认 `http://localhost:3000`。只包含协议、域名和可选端口，不带路径或末尾斜线；生产须 HTTPS |
| `DATABASE_URL` | 留空使用本地 PGlite；设置后使用外部 PostgreSQL |
| `DATA_DIR` | `./data/board-games`，本地 PGlite 持久化目录 |
| `NODE_ENV` | 设置 `production` 后要求外部 PostgreSQL 和 HTTPS origin，Cookie 启用 Secure，测试工具强制关闭 |
| `SESSION_DAYS` | `180`，匿名凭证有效期，支持 1–365 天 |
| `HOUSEKEEPING_INTERVAL_MS` | `300000`，周期任务间隔，最小 1000 毫秒 |
| `ENABLE_TEST_TOOLS` | `false`；仅非生产环境下精确设置 `true` 才会启用 |

### 本地数据与任务进程

PGlite 数据目录应保留在持久化磁盘。正常重启会复用已有数据；需要备份时先停止应用，再备份整个目录。不要在应用运行期间移动或删除数据文件。

**一个 PGlite 数据目录只能由一个应用进程打开。** 本地 API 已包含结算和清理任务，不要对相同目录另外启动 API、迁移命令或 worker；独立 worker 会要求 `DATABASE_URL`。

### 外部 PostgreSQL

配置专用 PostgreSQL 数据库和连接信息，例如：

```powershell
$env:DATABASE_URL = 'postgresql://board_game:your-password@localhost:5432/board_game'
npm run db:migrate
npm start
```

生产环境设置 `NODE_ENV=production`，在 HTTPS 反向代理后运行应用。Render 自动提供 `RENDER_EXTERNAL_URL`，应用在未设置 `PUBLIC_ORIGIN` 时直接使用它；其他平台或自定义域名应显式设置真实的 HTTPS `PUBLIC_ORIGIN`。根据数据库服务要求配置连接字符串中的 TLS 选项，连接凭证放在部署环境配置中。

外部 PostgreSQL 模式可额外运行 `npm run worker`。API 内置任务仍可工作；它们共用活动行锁和幂等结算逻辑，重复检查不会重复分配。

### Render Docker + Supabase

在 Render 创建 Docker Web Service，连接此仓库和目标分支，Dockerfile Path 使用 `./Dockerfile`。仓库根目录包含项目文件时，Root Directory 留空。应用和数据库尽量选择相近地区。

在 Render 的 Environment 中设置：

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `10000` |
| `DATABASE_URL` | Supabase Session pooler 的完整 PostgreSQL URI，端口 5432，启用 `sslmode=require` |
| `ENABLE_TEST_TOOLS` | `false` |

首次部署可以不设置 `PUBLIC_ORIGIN`，应用会自动使用 Render 分配的 HTTPS 网址。绑定自定义域名后，显式设置 `PUBLIC_ORIGIN` 为该域名的完整 HTTPS origin。不要将 `${RENDER_EXTERNAL_URL}` 这样的变量表达式作为普通环境变量的字面值填写。

**Docker Command 留空。** 项目 Dockerfile 自带 `CMD ["node", "dist/server.js"]`，无需额外的 shell/export 启动命令。若已有自定义 Docker Command，请在 Settings → Build & Deploy 中清空并保存，再部署最新提交。日志中的 `/bin/sh: export …: not found` 属于自定义启动命令解析错误，清空该覆盖项后使用默认 CMD。

Health Check Path 设置 `/api/v1/health/ready`。启动时自动执行数据库迁移。Supabase 仅作为后端的 PostgreSQL 使用，关闭不使用的 Data API，连接串仅保存在 Render 环境配置中。

Render Free 实例休眠期间不会运行周期任务；唤醒时会补跑。需要准时结算和清理时，使用常驻实例。参考 [Render Docker 配置](https://render.com/docs/docker) 和 [默认环境变量](https://render.com/docs/environment-variables)。

### Docker Compose（可选）

安装 Docker 后，可在项目根目录运行：

```powershell
docker compose up --build
```

Compose 同时启动应用和 PostgreSQL，默认仅在本机 `127.0.0.1:3000` 发布 Web 端口，数据库使用命名 volume 持久化。浏览器打开 [http://localhost:3000](http://localhost:3000)。配置入口仍为 `.env`；更改本机端口时同步设置 `PUBLIC_ORIGIN`。

提供的默认数据库密码用于本地开发；部署时设置独立的 `POSTGRES_PASSWORD`，并按上述生产配置启用 HTTPS。当前环境没有 Docker，本次未执行 Compose 构建和启动验证。

## 测试工具

仅在独立开发/测试数据环境使用：

```powershell
$env:ENABLE_TEST_TOOLS = 'true'
npm start
```

活动 owner 会看到测试面板，可以批量创建测试玩家、创建测试 Host 桌游、模拟加入/退出、均匀填充报名、预览分桌和清理。服务端也检查 owner 与环境开关，隐藏按钮不是唯一限制。

预览复用正式分配算法，不修改活动或报名。同一快照和 seed 得到同一结果；后续报名变化可能影响最终名单。

清除测试用户会删除其活动关系及测试 Host 的桌，并按删桌规则释放相关报名，保留真实用户身份和其他活动数据。清除整个测试活动会将测试身份保留到当前 owner 的复用池，新活动可通过测试复用入口重新加入池中尚未关联活动的身份。测试身份不能通过普通浏览器凭证登录，也不能成为管理员或 owner。

## 验证与接口

运行 `npm test`、`npm run check` 和 `npm run build` 验证当前代码。测试默认使用 PGlite，覆盖算法、匿名权限、事务一致性、候补、结算和清理。

本次已分别在 PGlite 和真实 PostgreSQL 18.6 上通过 37 项测试，并通过 TypeScript 检查与构建；外部 PostgreSQL 路径包含多连接竞争场景。

另新增 7 项 Render 环境配置与生产模式测试，覆盖平台地址自动识别、自定义域名、HTTPS 校验、Secure Cookie 和跨站请求拒绝。当前默认测试共 44 项通过。

浏览器已验证创建活动、通过活动码进入、只填写姓名加入、开桌与匿名报名入席。编译版本重启后测试活动及报名仍保留；依赖审计为 0 个已知漏洞。界面验证截图见 [匿名报名成功](docs/anonymous-registration.png)。

若需自行验证外部 PostgreSQL，可将 `TEST_DATABASE_URL` 指向独立测试数据库后运行测试。测试会写入数据，不能使用生产数据库。

另提供 `node scripts/test-postgres.mjs`，使用 `POSTGRES_BIN` 指定的 PostgreSQL 二进制，或项目 `.tools/postgres` 中的可选本地测试工具，创建并停止一个独立的 loopback 测试集群。缺少二进制时会明确跳过；它不会安装系统服务或修改已有数据库。

接口说明见 [docs/API.md](docs/API.md)，完整产品与实施约定见 [PLAN.md](PLAN.md)。健康检查为 `/api/v1/health/live` 和 `/api/v1/health/ready`，路由描述为 `/api/v1/openapi.json`。
