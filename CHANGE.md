# 更新日志

本文档记录 dsh-proxy 的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
