# 麻将记账 · 本地开发包

> 广东麻将本桌记账：报胡型 + 摸马 + 杠分 → 自动算分预览 → 确认/手改落账 → 实时看板 / 最少转账结算 / 战绩走势。
> **零外部依赖、零构建、单端口**。解压即跑，**不需要 `npm install`**。

包含完整源码、需求规格、设计方向契约与验收证据；运行时数据库和 LLM 密钥**不在包内**。

---

## 1. 三步跑起来

| 步骤 | 命令 / 操作 |
|---|---|
| 1. 确认 Node | `node -v` → 需 **≥ 22.5**（依赖 `node:sqlite` 与 TypeScript 类型擦除） |
| 2. 启动服务 | `npm start`（= `node --experimental-sqlite --experimental-strip-types server.mjs`） |
| 3. 打开页面 | <http://localhost:3000> |

Windows 可双击 `start.bat`；WSL2 / macOS / Linux 用 `./start.sh`（若解压后丢失执行位，用 `sh start.sh`）。这两个脚本**只做启动一件事**，不改数据、不装依赖、不检查数据库、不杀进程。

首次启动会自动创建 `data/mahjong.db`，页面是空的，直接「开新局」即可。想带演示数据启动，见 §7。

> **Node 版本说明**：Node 22.x 必须带 `--experimental-sqlite`；Node 23+ 默认可用（保留该 flag 也只多一条实验特性警告）。低于 22.5 请升级到 22 LTS 或 24 LTS。
> **端口占用**：`PORT=3001 npm start`。本地不需要 `sharecode`（那是发布环境的分享凭据，前端会自动兼容有无两种情况）。

---

## 2. 环境要求

| 项 | 要求 | 备注 |
|---|---|---|
| Node.js | ≥ 22.5（`type: module`） | 只用内置模块：`node:http` / `node:sqlite` / `node:fs` |
| npm | 任意（仅用于跑 `scripts`，无依赖需要安装） | 没有 `package-lock.json` 是刻意的 |
| 构建工具 | 无 | `public/` 是原生 HTML/CSS/JS，改完刷新即生效 |
| 数据库 | 无 | SQLite 单文件，由 `lib/store.mjs` 自动建表 |
| 浏览器 | 现代浏览器 | 语音输入用 Web Speech API / 手机输入法语音转文字 |

---

## 3. 目录结构

| 路径 | 职责 | 改它时要注意 |
|---|---|---|
| `lib/rules.ts` | **规则单一真相源**：底分、硬胡倍数、7 档 23 个别名、摸马张数 | 改底分/倍数/4↔6 张只改这里，别在别处写死 |
| `lib/score.ts` | `scoreRound()` 纯函数：一局 → 四家净分 + 马命中 + 杠分明细 | 内含零和断言、超张数机械校验；LLM 绝不产分数 |
| `lib/settle.ts` | `minTransfers()` 最少转账 + 平衡断言 | — |
| `lib/store.mjs` | `node:sqlite` 持久化、房间/事件表、`computeState()` 重放 | 账本 **append-only**：改=追加 `correct`，删=追加 `void` |
| `lib/parse.mjs` | 自然语言 → `RoundInput`；LLM 失败降级「规则模式」 | 结构化输出校验，非法输出拦截并如实标注 |
| `lib/llm.mjs` | OpenAI 兼容 provider（DeepSeek / Qwen / 自定义） | 密钥只留服务端，不回显前端 |
| `lib/vlm.mjs` | Qwen3.7 视觉调用（`chatVision`） | 与文本 LLM 分开；默认 `qwen3.7-plus` |
| `lib/vision.mjs` | 照片 → 待确认牌面草稿 | **不算分**；张数/横竖/杠/鬼/特殊胡进核对弹窗 |
| `lib/pattern.ts` | 确认后的牌面 → 胡法档位建议 | 多档取最高倍数 |
| `server.mjs` | 原生 HTTP 单端口、静态资源 `no-store`、全部 API 路由 | 绑定 `0.0.0.0`，便于局域网手机访问 |
| `public/index.html` / `style.css` / `app.js` | 前端三件套，零构建 | `app.js` 依赖 63 个 DOM 钩子，改 HTML 前先看 §9 |
| `scripts/verify.ts` | 14 个规则算例回归 | 改规则后必跑 |
| `data/` | 运行时生成（空目录，仅 `.gitkeep`） | 已 gitignore |
| `demo/mahjong-demo.db` | 可选演示账本（含验收房间 QBWEZZ 的 3 局） | 只读快照，不含密钥 |
| `docs/` | 规格、设计方向、18 张实拍证据 | 见 §10 |

---

## 4. 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `MJ_DB` | `data/mahjong.db` | SQLite 路径，可指向外置盘/演示库 |
| `MJ_LLM_API_KEY` | 空 | 有值即启用 LLM，且**优先于**网页里填的配置 |
| `MJ_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `MJ_LLM_MODEL` | `deepseek-chat` | 模型名 |
| `MJ_LLM_DISABLED` | 未设 | `=1` 强制停用 LLM，走规则模式 |
| `MJ_LLM_CONF` | `data/llm-config.json` | 网页设置保存的配置文件路径 |
| `MJ_VLM_API_KEY` | 空 | 拍照认牌专用通义 Key；不设则尝试复用「通义千问」文本通道的 Key |
| `MJ_VLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Qwen3.7 视觉端点 |
| `MJ_VLM_MODEL` | `qwen3.7-plus` | 视觉模型名 |
| `MJ_VLM_CONF` | `data/vlm-config.json` | 拍照识别独立配置 |

Windows PowerShell 示例：

```powershell
$env:PORT=3001; $env:MJ_LLM_API_KEY="sk-xxx"; npm start
```

WSL2 / bash 示例：

```bash
MJ_DB=./demo/mahjong-demo.db PORT=3001 npm start
```

---

## 5. 改了规则怎么验证

```bash
node --experimental-strip-types scripts/verify.ts
```

14 个算例覆盖：底分与表值回归、三种杠分、马牌座位映射、硬胡 6 张合法 / 7 张拦截、手改、零和不变量。全部通过会打印 `全部算例通过`。

服务起来后另可查：

```bash
curl http://localhost:3000/api/health     # {"ok":true,"baseUnit":2}
curl http://localhost:3000/api/rules      # 规则表 + horseCount {withGhost:4,withoutGhost:6}
```

---

## 6. 计分数据流（改功能前先记住）

```
语音/文字 → lib/parse.mjs（LLM 只输出 {winner, pattern, hasGhost, horses, gangEvents}）
          → normalizeInput() → lib/score.ts scoreRound() → 预览页（可手改）
          → 确认 → lib/store.mjs append "score" 事件 → 重放得净分 → 看板/结算

拍照 → lib/vlm.mjs chatVision() → lib/vision.mjs 草稿
     → 核对弹窗（VLM 易错项全部确认）→ /preview → scoreRound() → 预览落账
```

**铁律**：LLM 和前端都不允许产出分数；分数只由可验证的纯函数计算。重放时只累加冻结的 `net`，不重算旧局，所以改规则不会翻历史账。

本桌规则要点：**无点炮，只有自摸，三家各付 1 份**；中马者额外付赢家 1 份（赢家自己中马不计）；多匹叠加；**摸马**张数＝有鬼 4 张、没鬼/硬胡 6 张；庄家只影响马牌相对座位映射，不影响主分与杠分。

---

## 7. 数据与演示账本

- `data/mahjong.db` 首次启动自动创建，同时会有 `mahjong.db-wal` / `-shm`（WAL 模式正常产物，**不要单独删**，备份时三个一起复制或停服后复制 `.db`）。
- 账本 append-only，`correct` / `void` 都是追加事件，历史不丢；结算用 `minTransfers()` 算最少转账笔数。
- 包内 `demo/mahjong-demo.db` 是 `VACUUM INTO` 导出的干净快照（7 房间 / 5 事件，其中 QBWEZZ 3 局，净分 东-18 南+16 西+32 北-30）。想带数据开发：

```bash
MJ_DB=./demo/mahjong-demo.db npm start
```

  或直接把该文件复制到 `data/mahjong.db`。**不要**在真实账本上直接调试改库逻辑。

- 想彻底重来：停服 → 删 `data/mahjong.db*` → 重启。

---

## 8. LLM / 语音（可选，不配也能用）

- 未配置或 LLM 连接失败时自动降级「规则模式」关键词解析，**页面会如实标注**，不会静默猜一个结果。
- 配置方式二选一：① 网页「设置」页填一次，存到 `data/llm-config.json`（密钥不回显）；② 本地开发用环境变量（优先）。
- 语音输入走浏览器 Web Speech API，或直接用手机输入法的语音转文字；拿到的文本再走同一条解析链路。
- 国内网络访问 DeepSeek / DashScope 如需代理，按你本机 Clash 配置正常走即可；服务端用的是标准 `fetch`。
- **拍照认牌**用独立的 Qwen3.7 视觉调用（`lib/vlm.mjs`），只读牌；张数、横竖、杠型、鬼牌、特殊胡全部进核对弹窗，确认后才走计分引擎。

---

## 9. 前端改动的契约

`public/` 由 `frontend-design-direction` 技能重构过，重构成果与约束写在 `docs/design-direction.md`：

- **保留 63 个 DOM id / class 钩子**，`app.js` 的事件绑定依赖它们；改 HTML 结构前先全局搜对应选择器。
- 原生零构建、390px 手机优先且 ≥900px 桌面真适配；六内容状态（空 / 加载 / 局部 / 错误 / 权限 / 成功）都有真实演练，证据在 `docs/evidence/`。
- 对比度最低 6.07:1、无 <44px 触摸目标、`prefers-reduced-motion`、`focus-visible`、SVG 图标替代 emoji。
- 后端接口与计分内核在前端重构时**零改动**，这条边界建议继续保持。

---

## 10. 文档清单

| 文件 | 内容 |
|---|---|
| `docs/需求规格-v1.4.md` | 定稿规格：规则图、底分 2、LLM、摸马 4/6、算例、数据模型、开发清单 |
| `docs/后续演进方向-讨论存档.md` | 积分板 / 语音助手 / 摄像头视觉 / 棋牌设备的讨论存档。**非实施规格、不排期**；明确「一台设备只是可选用法，不替换多人各自输入」 |
| `docs/design-direction.md` | 前端设计方向 + Evidence Contract（可检查约束） |
| `docs/evidence/` | 18 张三视口实拍 + `evidence.json` / `measurements.json` |

线上对照版本：<https://a5b3107a797896dc0.app.workbuddy.host/?sharecode=LDVVFWWRHJ>（`sharecode` 不能丢）。演示牌局加 `&room=QBWEZZ&me=E`。

---

## 11. Windows / WSL2 注意

- 建议在 **WSL2 内**跑 Node（与线上 Linux 环境一致）；在 Windows 原生跑也可以，路径分隔符由代码内部 `join()` 处理。
- 若用 WSL2，从 Windows 浏览器访问需要 WSL2 的 IP 或直接 `localhost`（Win11 支持 localhost 转发）；手机同局域网访问请确认防火墙放行该端口。
- 端口 3000 若被别的服务占用，用 `PORT=3001 npm start`，不要去 kill 别的进程。
- 中文文件名的 zip 在 Win10/11 资源管理器可直接解压；若出现乱码，改用同包的 `.tar.gz` 在 WSL2 内解压（`tar -xzf`）。

---

## 12. API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回 `baseUnit` |
| GET | `/api/rules` | 规则表、别名、摸马张数 |
| POST | `/api/rooms` | 建房（返回 6 位房间码）；加入房间是前端用房间码直接进 |
| GET | `/api/rooms/:code` | 完整状态（重放得出） |
| POST | `/api/rooms/:code/preview` | 算分预览（不落账） |
| POST | `/api/rooms/:code/events` | 落账 / 手改 / 作废 |
| POST | `/api/rooms/:code/parse` | 自然语言 → 结构化字段 |
| POST | `/api/rooms/:code/vision` | 照片 → 牌面草稿（不算分）；核对后走 `/preview` |
| GET/POST | `/api/vlm-config` | 拍照识别配置（脱敏）/ 保存 |
| GET/POST | `/api/llm-config` | 读取（脱敏）/ 保存 / 测试连接 / 停用 |
