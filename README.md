# AI 订阅仪表盘 (ai-sub-dashboard)

![Release](https://img.shields.io/github/v/release/Lqg97/DashboardForAI)
![Stars](https://img.shields.io/github/stars/Lqg97/DashboardForAI?style=social)
![Last commit](https://img.shields.io/github/last-commit/Lqg97/DashboardForAI)

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js)
![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-informational)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

简体中文 | [English](README_EN.md)

把你在用的 AI 编程工具的**用量、额度、成本和回本率**汇总到一个看板。数据全部来自本机
已有的日志文件:**不开账号、不联网上报、零运行时依赖**。


## 目录

- [功能一览](#功能一览)
- [界面截图](#界面截图)
- [快速开始(单机)](#快速开始单机)
- [页面导览](#页面导览)
- [数据源](#数据源)
- [额度与成本口径](#额度与成本口径)
- [HTTP API](#http-api)
- [订阅与凭据配置](#订阅与凭据配置)
- [可选:联机模式(服务器 + 客户端)](#可选联机模式服务器--客户端)
- [桌面 App](#桌面-app)
- [环境变量](#环境变量)
- [自测](#自测)
- [隐私与开源协议](#隐私与开源协议)

## 功能一览

- **5h & 周额度**:official(日志内嵌官方数据)→ api → manual(手填)→ estimate(滚动窗口用量);未配置真实上限时不伪造百分比
- **Coding Plan 额度**:支持 Kimi、智谱个人/团队、MiniMax、ZenMux、OpenCode Go、火山方舟 Agent/Coding Plan;每个凭据独立缓存,只有瞬时网络失败才保留同账号的上次成功值
- **API 折算成本**:单价三层来源 pricingOverrides(手填)→ models.dev 同步 → 内置表
- **ROI 回本率**:本账单周期 API 等效成本 ÷ 月费
- **重置倒计时**:每个配额窗口显示剩余时间
- **沉睡提醒**:14 天未用的订阅高亮
- **用量分析**:7×24 热力图(本地时区)、堆叠柱状、成本折线、工具占比环图
- **订阅台账**:增删改订阅、导出 CSV / JSON
- **卡片显隐**:统计块与订阅卡片可逐个开关,偏好存浏览器本地,不上传

## 界面截图

**总览** — 订阅卡片、5h / 周额度、账单周期与近期用量

![总览](docs/screenshots/overview.png)

**用量分析** — 工具维度堆叠柱状、成本折线、7×24 热力图、占比环图

![用量分析](docs/screenshots/analytics.png)

**订阅台账** — 订阅增删改、按渠道主体汇总、导出 CSV / JSON

![订阅台账](docs/screenshots/ledger.png)

> 截图用演示订阅数据生成,避免出现真实订阅名;统计块与图表仍反映截图当时的本机用量。

## 快速开始(单机)

```bash
cd ai-sub-dashboard
npm start          # http://127.0.0.1:4780
```

- 需要 **Node >= 22**(用到内置 `node:sqlite`)
- 单机模式**零 npm 依赖**,不用 `npm install`
- 联机 Hub 服务端额外依赖 `mysql2`(仅服务端),要装:`npm install`

## 页面导览

| 页面 | 内容 |
| --- | --- |
| 用量分析 | 堆叠柱 / 成本折线 / 热力图 / 占比环图(工具维度) |
| 订阅台账 | 订阅表格 + 导出 |

## 数据源

| agent | 来源 | 说明 |
| --- | --- | --- |
| claude | `~/.claude/projects/**/*.jsonl` | `type=assistant` 的 `message.usage` |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | `token_count` 事件差分;`rate_limits.primary` 为 official 额度源 |
| opencode | `~/.local/share/opencode/opencode.db` | `message` 表,`providerID` 区分 opencode / codebuddy |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | `message.usage`;模型名去 provider 前缀与 `:variant` |
| agy | `~/.gemini/antigravity-cli` | Antigravity CLI(Gemini);会话库 `gen_metadata` 的 protobuf,含 input / output / 缓存前缀;时间戳对齐 `transcript.jsonl`,项目取工作区路径 |
| cursor | Cursor 本地状态库 | 已观测请求与模型;没有显式套餐上限时不伪造 500 次额度 |
| 手动 | `data/config.json` | 台账 UI 增删改,含 quota 手填兜底 |

## 额度与成本口径

**配额窗口**:优先级 `official` → `api` → `manual` → `estimate`。只有在拿到官方值或
显式配置上限后才计算百分比,否则上限显示为「未知」。

**定价来源**:启动时后台拉取 `https://models.dev/api.json`(24h TTL,失败用缓存/内置表),
按文本模型过滤 + canonical provider 优先 + normalizedId 去重,同参考实现 cc-switch。
models.dev 无价的内部池模型(ioa 系等)在快照 `unpricedModels` 里提示,可用
`config.json` 的 `pricingOverrides` 手填。

**归属说明**:当前订阅条目通过 `agentIds` 关联工具,本地日志按可选 `modelFilter` 过滤。
若两个订阅关联同一工具且没有互斥过滤条件,现阶段可能重复归属;不要用它作为正式账单
分摊依据。后续按方案使用 CC Switch 的复合 Provider 键 `(app_type, id)` 做一次性归属。

(例如 `["workbuddy-suite"]`)。同一 `quota_product` 下的多个展示行会合并用量,但额度只计一次。


Cursor 的本地日志可展示已观测请求数;只有配置 `quotaOverrides.cursor.monthLimitReqs`
时才展示请求额度,未配置时上限保持未知。

## HTTP API

- `GET /api/agents` — AgentRecord 快照(带缓存)
- `POST /api/refresh` — 立即重扫
- `GET|PUT /api/config` — 订阅配置(原子写入,校验失败 400)
- `GET /api/export?format=csv|json` — 导出

## 订阅与凭据配置

订阅在「管理订阅」弹窗里增删改,存于 `data/config.json`(已 git 忽略,仓库只提供无凭据的
`data/config.example.json`)。

额度凭据填写规则:智谱接口使用原始 API Key(不加 `Bearer`);智谱 Team 还需要
Organization ID 与 Project ID;火山方舟额度查询使用控制面 AK/SK,而不是推理 API Key;
ZenMux 需要填写其额度端点作为 Base URL。

**卡片显隐**:总览页「卡片显示」可逐个开关统计块与订阅卡片,偏好存浏览器 `localStorage`
(键 `ai-sub-dashboard.cards.v1`),不随上报上传,单机与联机看板都生效。卡片上的「隐藏」
按钮是快捷入口,恢复在「卡片显示」里。

## 可选:联机模式(服务器 + 客户端)

```text
客户端(每台机器)                          Hub 服务器
┌──────────────────────────┐   POST /api/report   ┌────────────────────────┐
│ server/client.js          │   每5分钟/被踢时     │        report_history   │
└──────────────────────────┘                      └──────────┬─────────────┘
                              浏览器 <───────────────────────┘
                              个人链接打开, 只能看到自己的数据
```

- **Hub**(服务端):收客户端上报、按 userId 存 MySQL(`user_reports` 最新快照 +
  `report_history` 上报历史)、托管前端。未配置 MySQL 或连接失败时降级为文件存储
  `DATA_DIR/users/`。
- **Client**(客户端):复用单机的采集/聚合代码构建本机快照,周期上报;收到 Hub 下发的
  刷新指令时立即重扫上报。**订阅凭据只存在客户端本机,上报快照不含凭据。**
- **上报开关(用户自主选择是否上传)**:桌面 App 托盘菜单、看板侧边栏卡片、CLI 三种方式
  任选,随时可关;`enabled: false` 即不上传。
- **用户隔离(无用户切换)**:通过**个人看板链接** `http://<hub>:<端口>/?user=<userId>&token=<HUB_TOKEN>`
  访问,Hub 以 HttpOnly Cookie 持久化身份,之后所有数据接口只返回该用户自己的数据,
  冒充他人 userId 会被拒绝(token 不符 401)。
- **管理员视图**:持 `HUB_ADMIN_TOKEN` 时可用 `?admin=<token>` 查看「全部用户汇总」。
- **用户区分**:默认用本机用户名 + 主机名,可用 `DASH_USER` / `DASH_MACHINE` 覆盖。

### 快速开始(联机)

```bash
# 服务器(部署 Hub + MySQL 容器, 幂等可重复执行; 首次会生成 HUB_TOKEN/HUB_ADMIN_TOKEN)
bash scripts/deploy-hub.sh
# 令牌存于服务器 /opt/ai-sub-dashboard/hub.env (600), 速查 /root/.ai-sub-hub-token

# 客户端(每台本地机器; DASH_TOKEN 与服务器 HUB_TOKEN 相同)
HUB_URL=http://<hub>:4780 DASH_TOKEN=<HUB_TOKEN> npm run client
# 单次上报: node server/client.js --once
```

### Hub API

| 接口 | 说明 |
| --- | --- |
| `POST /api/report` | 客户端上报 `{userId, machine, token?, snapshot}` |
| `GET /api/me` | 当前访问者身份 / 客户端在线状态 |
| `GET /api/agents` | 当前用户快照(未认定身份 401);管理员 = 全部用户合并 |
| `POST /api/refresh` | 给当前用户下发刷新指令,客户端 ≤15s 内领取重扫上报 |
| `GET /api/history` | 当前用户上报历史 |
| `GET /api/export?format=csv\|json` | 导出当前用户数据(管理员=全部,含 user 列) |
| `GET /api/users` | 用户列表(仅管理员) |
| `POST /api/users/delete` | 删除某用户全部数据(仅管理员) |

### 合并口径(管理员视图)

- 工具层 agents:各用户用量 / token 求和,按日对齐为最近 30 天;额度是每用户/每机器口径,
  不合并百分比,明细在 `agents[].users[]`。
- 订阅层 subscriptions:各用户条目并列展示,附加 `user` 归属字段。
- 不同客户端上报周期不同步、数据时点略有差异,汇总值为近似值。

## 桌面 App

```bash
npm run app        # Electron 托盘常驻 + 独立窗口
```

托盘菜单可直接开关联机上报、打开设置、同步模型定价、设开机自启。

> **未签名说明**:没有 Developer ID 证书,产物为 ad-hoc 签名。别人首次打开会被 Gatekeeper
> 拦下,需执行一次 `xattr -cr "/Applications/AI Sub Dashboard.app"`,或右键 → 打开。

## 环境变量

**单机**:`PORT`(4780)· `RESCAN_INTERVAL_MS`(300000)· `CLAUDE_DIR` / `CODEX_DIR` /
`OPENCODE_DB` / `PI_DIR` / `AGY_DIR`(覆盖数据路径)· `DATA_DIR`

**额度凭据**:`KIMI_API_KEY` · `ZHIPU_API_KEY` / `GLM_API_KEY` · `MINIMAX_API_KEY` ·
`ZENMUX_API_KEY` · `OPENCODE_GO_API_KEY` · `VOLCENGINE_ACCESS_KEY_ID` ·
`VOLCENGINE_SECRET_ACCESS_KEY`

写入看板配置或快照)

**Hub 服务端**:`HUB_PORT`(4780)· `HUB_HOST`(0.0.0.0)· `HUB_TOKEN` · `HUB_ADMIN_TOKEN` ·
`HUB_ONLINE_WINDOW_MS`(10 分钟)· `MYSQL_HOST` / `PORT` / `USER` / `PASSWORD` / `DATABASE` ·
`HUB_HISTORY_KEEP`(288 ≈ 24h)

**客户端**:`HUB_URL` · `DASH_USER` · `DASH_MACHINE` · `DASH_TOKEN` · `REPORT_INTERVAL_MS`(300000)

## 自测

```bash
npm test                    # 单机 + 联机全部单测
npm run test:coverage
npm run selftest            # 各 collector + 真实数据断言
node server/quota/_selftest.js
node server/insights.test.mjs
```

## 隐私与开源协议

- 所有采集都在本机进行,读的是工具已经写好的日志文件
- 联机模式下上报的快照只包含用量数字和订阅元数据,**不含任何 API Key 或凭据**
- 上报默认关闭,需要你主动打开

本项目采用 [GNU General Public License v3.0](LICENSE) 授权:

- 可自由使用、修改和分发,包括商业用途
- 分发(含修改版本)时必须**同样以 GPL-3.0 开源**,保留版权与协议声明
- 必须公开源代码;软件按「原样」提供,不含任何担保
- 前端 `public/vendor/chart.umd.min.js`(Chart.js)为 MIT 协议,与 GPL-3.0 兼容,单独保留其原有授权

## 关于本仓库

本仓库由内部仓库定期导出生成, 单一初始 commit, 不含任何内部地址与凭据。
Hub 地址与令牌请在客户端「联机设置」中自行填写(内置默认值为空)。
