# AGENT.md — 二次开发手册（给改代码的人或 AI）

> 先读 [README-AI.md](README-AI.md) 的红线（§2）。本文只讲"怎么改"，不讲"为什么这么设计"。
> 每次交付的固定动作在下文 §1，**不许跳过 §1.3 的测试**。

---

## 1. 工作循环

### 1.1 环境

```
仓库根：D:/Work/Agent/plugin/dsh-review-hub        （Windows 本机示例）
宿主 profile：~/.dsh/profiles/desktop
数据目录：~/.dsh/storages/review-hub/
```

- 服务端半身（`src/index.js` 及其依赖）**加载时绑定**：改完必须重启宿主。
- 客户端半身（`src/client.js`）由 web server 直接从磁盘取：**刷新页面**即可，不必重启。
- 客户端是**字符串里的单文件 bundle**（`window.__ModuleLoader__.load({ id, factory })`），没有构建步骤，也没有 `require` 其它本地文件的能力（只能 `require('react')`）。

### 1.2 改一行代码前

```bash
node --check src/<你改的文件>.js
```

### 1.3 交付前（必须全绿）

```bash
node --check src/*.js
node test/run.mjs        # 目前 71 用例
```

再按影响面重启宿主，肉眼过一遍：

| 改动面 | 验收 |
|---|---|
| 审批判定 | 触发一次只读提权（应 AI 通过）、一次 `echo` 连批三次（第 4 次应记忆通过）、一次 `Remove-Item -Recurse`（应人工） |
| 提示卡 | 卡片出现在**输入框上方**、不顶动输入框、按设置的时长消失、复制/关闭可用 |
| 审批页 | 时间线、查找、红点、`以上为新增审批` 分割线、设置面板 |
| diff/撤销 | 行内「改动」→ 右侧栏 tab；撤销需连点两次 |
| 设置 | 日常项在审批页、高级项在插件页、改完刷新仍生效（`/config` 回读一致） |

---

## 2. 配方：加一个设置项

一个设置要**同时改五处**，漏一处就会"能存不能读"或"存了被 clamp 掉"：

1. `src/store.js` → `DEFAULT_SETTINGS`（默认值）；数值型还要进 `BOUNDS`，布尔型进 `clampSettings` 的字段循环；
2. `src/routes.js` → `CONFIG_FIELDS`（否则 `POST /config` 会把它过滤掉）；
3. `src/client.js` → 中文 `zh` 与英文 `en` **成对**加文案（有断言检查键数相等）；
4. `src/client.js` → 选一个面板：日常项放 `SettingsPanel`（审批页），高级项放 `ConfigCard`（插件页）。布尔用 `row(...)`（滑块），数值用 `numRow(...)`（`onBlur` 提交）；
5. `test/units.test.mjs` 或 `client.smoke.mjs` 加断言（建议：`clampSettings` 的边界 + 文案存在）。

嵌套对象（如 `hintMs`）注意：`clampSettings` 里要**逐键合并**，前端保存时要用 `Object.assign({}, old, { [k]: v })`，否则会把兄弟键抹掉。

---

## 3. 配方：加一类硬风险（L0）

1. `src/policy.js` 新增 `const XXX = [正则...]`（**用命令文本匹配，不要匹配 JSON 键名**：`commandText()` 已经从 shell 工具的参数里取出命令）；
2. 加进 `CLASSES`，顺序决定 `riskRule` 的优先级标签；
3. 考虑误伤：写 `test` 正反例各一条（"该命中"与"不该命中"必须都有）；
4. 不要忘记它自动继承既有语义：**不送 AI、不进记忆、不计数**。

---

## 4. 配方：改工具策略（L1）

`src/policy.js` 的 `DEFAULT_TOOLS_POLICY.overrides`：值是 `'ai' | 'memory' | 'human'`（`tierOf` 会与 `agentPolicy` 的档位取更严的一方）。
改完同步检查 `pipeline.test.mjs` 里对应的归属断言。

---

## 5. 配方：加一种提示卡（客户端）

1. `src/index.js`：让记录行带上区分字段（例如 `decidedBy` 的新值，或新字段）；
2. `src/routes.js`：SSE 的 `entry/entries` 帧原样带行，不用改；
3. `src/client.js`：
   - `store.hints` 的 `kind` 决定样式类 `.ah-card-<kind>`；
   - `pushHint(kind, entry)` 的 TTL 从 `hintMsOf(kind)` 取 → 记得在 `settings.hintMs` 里加键，并同步 `store.js` 的 `HINT_BOUNDS`；
   - 新样式写在 CSS 数组里，颜色走 `--ah-*` 变量（**不要**硬编码新色值）；
   - 文案 zh/en 成对。

---

## 6. 配方：加一条 HTTP 路由

```js
// src/routes.js
stream: ROUTE_PREFIX + '/your-route',            // 1. ROUTES 里加名字
// 2. routes 数组里加一条：
{
  kind: 'exact',                                  // 或 'prefix'
  path: ROUTES.yourRoute,
  handler: guard(async (req, res) => {
    sendJson(res, 200, { ok: true });             // 记得走 sendJson（自带 header）
  }, ['GET', 'HEAD']),                            // 3. 方法白名单，别漏 GET
},
```

`guard` 已含同源围栏与方法门，**不要绕过它**。需要长连接参考 `/stream`：自己 `writeHead`、自己清理 `req.on('close')`。

---

## 7. 配方：加一个客户端席位 / 右侧栏面板

```js
// 普通席位
mount({ name: 'conversation.view', id: 'review-hub.xxx', order: 20, label: '审批',
        inject: (sessionId) => ({ sessionId }) }, YourComponent);

// 右侧栏：先注册 tab 类型，再注册面板，key 必须等于 type id
ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scoped) => {
  ctx.effect(() => scoped.sidebarRightTabs.register({
    id: 'review-hub-diff', kind: 'review-hub-diff',
    keepMounted: true, priority: 'extension', title: () => '改动',
  }), 'review-hub: tab type');
  mount({ name: 'sidebar.right.pane.tab', key: 'review-hub-diff', locale: NS }, Panel);
  scoped.sidebarRight.openTab('review-hub-diff', { revealIfOpened: true });
});
```

要点：可选服务一律 `ctx.inject` + `typeof` 检查 + `try/catch`，宿主没有该能力时要**降级**（例：diff 退回行内）而不是白屏。

---

## 8. 代码约定

- 缩进 **Tab**；单引号；不用分号省略式写法（仓库现有风格）。
- 注释只写"为什么"，不写"是什么"；每条不显然的取舍写清代价（例：为什么缓存键跨会话而记忆键不跨）。
- 客户端**不能**引入依赖、不能用 emoji 当图标、不能用文字当图标按钮（要在 `title/aria-label` 里给文字）。
- 颜色只用主题 token（`--dsw-alias-*`）或本插件的 `--ah-*` 变量。
- 中文文案面向"会用电脑但不懂实现"的人：一句话说清后果（例："超时按「拿不准」处理，转人工"）。
- 任何 `zh` 文案必须有对应 `en`（测试断言键数相等）。

---

## 9. 调试手段

| 手段 | 用途 |
|---|---|
| `GET /api/review-hub/health` | answerer 是否注册、五个计数器、reviewer 是否可用、store 可写 |
| `GET /api/review-hub/entries?session=<sid>&limit=5` | 最近几行原始记录（含 `aiSource/fpMode/droppedKeys`） |
| `GET /api/review-hub/stream?session=<sid>` | 用 `curl -N` 看 SSE 帧；正常先来 `ready` + `pending`，之后 30s 一个 `ping` |
| 浏览器 Console | `[review-hub]` 前缀的错误：席位注册失败、样式注入失败、`openTab` 失败 |
| `localStorage` | `review-hub:floor:<sid>` / `review-hub:seen:<sid>`；异常时清掉再刷新 |
| 启动失败 | `%APPDATA%@deepseek-ai/dsh-desktop/logs/crash-*-web-boot.log`（先看这里，别猜） |

数据文件都小，直接读 `~/.dsh/storages/review-hub/*.json` 就能确认"是不是压根没写进去"。

---

## 10. 常见改动的连带影响（容易漏的）

| 你改了 | 还要同步 |
|---|---|
| `row` 的新字段 | `src/export.js` 的 `EXPORT_FIELDS`（台账列）+ `client.js` 的筛选 `haystack` |
| 新设置 | `DEFAULT_SETTINGS` / `BOUNDS` / `clampSettings` / `CONFIG_FIELDS` / 文案 zh+en / 测试 |
| 新硬风险类 | `CLASSES` + 正反例测试 + `README-AI.md` §2 的类别列表 |
| 指纹旋钮清单 | 只能"加"不能"删"；同时在 `CHANGELOG.md` 记一行"加了哪个键、依据哪条分裂记录" |
| SSE 帧格式 | 客户端 `entries` **和** `entry` 两个监听都要覆盖（前者是合并帧） |
| 席位 `label` | 只能字符串/函数，且改动必须重注册（见 `pushTabLabel`） |
| `/diff` 语义 | 右半边必须用 `entry.afterHint`，不要读磁盘当前内容 |
| 撤销指令文案 | 必须带 `id` 字段，且不要承诺插件自己改文件 |

---

## 11. 提交前 checklist

- [ ] `node --check src/*.js` 无输出
- [ ] `node test/run.mjs` 全绿（当前基线 **71 passed**）
- [ ] 新增文案 zh/en 成对
- [ ] 新设置五处齐全（默认/BOUNDS/clamp/CONFIG_FIELDS/UI+文案）
- [ ] 客户端改动刷新页面验证过（不是只跑测试）
- [ ] 宿主侧改动重启后 `/health` 的 `counters.external` 仍为 0
- [ ] `CHANGELOG.md` 加了一节（做了什么、为什么、已知取舍）
- [ ] 若改了对外行为/设置位置，同步 `README.md` / `README-EN.md` / `README-AI.md`
