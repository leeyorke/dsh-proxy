# 更新日志

本文档记录 dsh-proxy 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## 0.1.4

### 变更

- 围栏 fail-closed：requestRejection 若被 harness 改名/移除，从前会抛出后请求永远挂起；现在拒绝（403）+ 日志点名原因——API 漂移既不能悄悄打开通道，也不会卡住设置页。
- 死socket 不再能击穿进程：响应 error 事件兜底 + dispatch 整体 try/catch，上传中途重置也有终态。

## 0.1.3

### 修复

- **修复 harness 升级后插件无法加载的问题（`cannot get property "webServer" without inject`）。** 新版 harness 将 `client-connection` 的静态注入从 `['webServer', 'credentials']` 缩减为 `['credentials']`（`webServer` 改为可选，仅在存在 Web 服务器时才运行时注入），而经 `connection.rpc.handle` 挂载的 `/dsh-proxy` 通道内部要从 client-connection 插件自身的 fiber 查找 `webServer`——该查找在新版下走到根 fiber 并抛出此错误，插件条目无法激活。现在通道的物理路由由插件自持：直接注册在注入的 `ctx.webServer` 上（与 harness 自带 api-gateway 挂 upgrade 路由同一模式），envelope 解析、body 上限、断连中止一并收进插件，不再依赖 harness 的专属通道挂载实现。
  - 涉及文件：`dsh-proxy/src/rpc-route.ts`（新增）、`dsh-proxy/src/index.ts`。

### 变更

- **`/dsh-proxy` 通道的信任策略与 `/api` 对齐。** 旧版通过 `rpc.handle` 的 `{ authority: 'loopback' }` 选项声明 loopback-only（该选项在新版 harness 中已被静默忽略，策略实际已失效）；现在每个请求先过 `ctx.connection.requestRejection`——Host/Origin 信任篱笆 + 浏览器会话认证。经代理的 LAN 流量因 Host/Origin 被改写为 loopback 上游照旧通过篱笆；首次访问需携带 `dsh web` 启动日志打印的 `?token=`（LAN 场景将其拼到代理地址之后），通过后浏览器会话 cookie 自动放行后续请求，与 Web UI 其余部分行为一致。
  - 请求体上限 1 MiB（设置页 payload 远小于此）；信封级错误（方法/端点不匹配、非法信封）以 HTTP 200 + 错误 envelope 返回，浏览器端不会抛传输层错误。

### 构建与工具链

- pinned 开发类型包对齐到当前 harness 内置版本：`@deepseek-ai/dsh-*` 精确到 `0.1.6-alpha.2`（例外：`@deepseek-ai/dsh-client-runtime` 无该发布，停留在最新已发布的 `0.1.1-rc.2`，客户端仅使用其稳定面）、`@deepseek-ai/cordis@^4.0.2`、`@deepseek-ai/schemastery@^3.18.2`。
- smoke 的插件契约阶段改为驱动**真实 bundled 路由**（fake `node:http` req/res）——旧 fake ctx 只捕获 handler 函数，恰好会掩蔽本次这类故障；新增 `DSH_SMOKE_SKIP_LIVE=1` 可只跑该阶段。

### 验证

- `pnpm run check` 通过：typecheck ✓、vitest 8 个文件 90 个用例 ✓（含新增 13 个通道路由用例）、esbuild 构建 ✓。
- `DSH_SMOKE_SKIP_LIVE=1 node scripts/smoke.mjs`：插件契约阶段 14/14 通过（路由挂载、信任围栏、status/update/start/stop、设置持久化、错误 envelope）。

## 0.1.2

### 修复

- **修复局域网客户端连接导致整个 DSH 进程崩溃的问题。** 移动端浏览器（尤其 iPad Safari 在 Basic Auth 弹窗前后建立、放弃、重试 WebSocket 握手）发送的 TCP RST，会落进代理的裸露窗口：认证拒绝分支直接对原始 socket 写入 401，而 `http-proxy` 的 WebSocket 转发在上游回应 101 之前也不挂载 `'error'` 监听器，任何一次 RST 都以未处理的 `'error'` 事件终止整个 `dsh web` 进程。现在代理在连接层统一观察 socket 错误：记录 warn 日志并销毁连接，进程不再受影响。
  - 涉及文件：`dsh-proxy/src/proxy.ts`（`server.on('connection', ...)` 观察者）。

- **修复 iOS Safari 需要输入两次账号密码的问题。** WebKit 不在 WebSocket 升级请求上自动重放页面的 Basic 凭据（与 Chromium 行为不同），而代理的升级路径同样要求认证，于是 Safari 只能为 WebSocket 再弹一次密码框。现在首次 Basic 登录成功后签发会话 cookie（`HttpOnly`、`SameSite=Lax`、浏览器会话级），HTTP 与 WebSocket 升级两条通道都接受「有效密码 或 有效 cookie」：
  - token 为每次代理启动随机生成的 64 位十六进制值，常数时间比较校验；伪造 cookie 一律 401；
  - 仅凭 cookie 的请求不会再次签发 Set-Cookie，token 不外泄给未认证调用方；
  - 关闭密码登录时行为不变，也不签发 cookie；
  - 行为变化：每次重启 `dsh web`（或在设置页重启转发服务）后各设备需重新登录一次。
  - 涉及文件：`dsh-proxy/src/session.ts`（新增 `SESSION_COOKIE` / `mintSessionToken` / `readCookie` / `sessionCookieHeader`）、`dsh-proxy/src/proxy.ts`。

### 变更

- **消除启动时的 `DEP0060: util._extend is deprecated` 警告。** 通过 pnpm 官方补丁机制将依赖 `http-proxy@1.18.1` 内两处 `util._extend` 替换为等价的 `Object.assign`（新增 `dsh-proxy/patches/http-proxy@1.18.1.patch`，并在 `pnpm-workspace.yaml` 注册 `patchedDependencies`）。功能无变化，警告不再出现。

### 构建与工具链

- 迁移到 pnpm 11 的配置新位置：esbuild 的构建脚本许可由 package.json 的 `pnpm.onlyBuiltDependencies` 迁至 `pnpm-workspace.yaml` 的 `allowBuilds`（旧字段在 pnpm 11 下已不被读取）；`pnpm-lock.yaml` 随补丁注册更新。

### 验证

- `pnpm run check` 通过：typecheck ✓、vitest 7 个文件 76 个用例 ✓、esbuild 构建 ✓。
- 独立复现环境验证：未打补丁时代理可被 RST 流量稳定击穿（与线上崩溃堆栈一致）；打补丁后同类流量全存活；单次登录、伪造 cookie 拒绝、纯 Basic 回归、HTTP/WebSocket 转发均通过断言。
