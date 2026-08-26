# dsh-proxy

[English](README.en.md) | 中文

HTTP + WebSocket 反向代理：把局域网端口转发到本地 DSH 服务 `127.0.0.1:3080`。
支持 Basic Auth、局域网访问、`crypto.randomUUID` polyfill 注入。

**注**：本仓库为 [@smanx/dsh-proxy](https://github.com/smanx/dsh-proxy)的 fork 版本，修复了以下问题：

> 从上游分支fork修了一些在safari上使用会产生的bug，最新兼容0.1.1-rc2，以后dsh更新不知道会不会兼容

1. socket 错误观察者（修 Safari 连接崩溃）
2. 会话 cookie 单次登录（修 Safari 双密码框）
3. util._extend → Object.assign（消除 DEP0060 警告）

详细修复细节见 [CHANGE.md](./CHANGE.md)


### 安装

**在线安装**——直接从 GitHub 安装（无需下载仓库）：

```bash
dsh plugin --profile web add github:leeyorke/dsh-proxy#master

# Windows 防火墙：若局域网设备连不上，为本机放行该端口（管理员 PowerShell）：
netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081

# 删除插件
dsh plugin --profile web remove leeyorke/dsh-proxy

```
