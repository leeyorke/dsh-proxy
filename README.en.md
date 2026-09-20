# dsh-proxy

English | [中文](README.md)

An HTTP + WebSocket reverse proxy that forwards a LAN port to the local DSH service at `127.0.0.1:3080`.
Supports Basic Auth, LAN access, and `crypto.randomUUID` polyfill injection.

**compatible with DSH 0.1.6-alpha.2 at present**

**Note**: This repository is a fork of [@smanx/dsh-proxy](https://github.com/smanx/dsh-proxy) carrying the following fixes:

> Forked from the upstream branch to fix several bugs that occur when using Safari;

1. Socket error observer (fixes the Safari connection crash)
2. Session-cookie single sign-on (fixes the double password prompt on Safari)
3. util._extend → Object.assign (removes the DEP0060 deprecation warning)

See [CHANGE.md](./CHANGE.md) for the fix details.


### Install

**Online install** — straight from GitHub (no need to download the repository):

```bash
dsh plugin --profile web add github:leeyorke/dsh-proxy#master

# Windows Firewall: if LAN devices cannot connect, allow this port for this machine (admin PowerShell):
netsh advfirewall firewall add rule name="dsh-proxy" dir=in action=allow protocol=TCP localport=3081

# Remove the plugin
dsh plugin --profile web rm leeyorke/dsh-proxy

# Update the plugin (use add, not up: pnpm's up does not re-resolve git
# branch refs and silently keeps the old commit; add fetches the branch head)
dsh plugin --profile web add github:leeyorke/dsh-proxy#master

```
