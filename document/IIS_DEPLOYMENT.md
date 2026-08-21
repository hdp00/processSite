# FlowPilot IIS 部署说明

## 1. 构建模式

部署前必须先确定数据来源，两种包不能混用：

```bash
# 正式部署：读取真实后端 /api/v1
pnpm build

# HTTP 原型演示：使用页面内 Mock 数据
pnpm build:debug
```

两种命令的输出目录均为 `apps/web/dist`，后执行的构建会覆盖前一次产物。部署时复制 `dist` 目录内的全部文件，而不是复制 `dist` 目录本身。

debug 包不注册 Service Worker，不要求 HTTPS。其流程状态保存在浏览器 localStorage，PDF、附件和富媒体正文保存在 IndexedDB；不同浏览器、电脑、域名、协议或端口之间不共享数据。

正式包不包含 Mock 代码，默认请求同源 `/api/v1`。IIS 主站必须将 `/api/*` 反向代理到监听 `127.0.0.1` 的后端服务；如果后端地址不同，应在正式构建前调整 `.env.production` 的 `VITE_API_BASE_URL`。

## 2. IIS 应用

在现有主站下创建或转换 IIS 应用：

- 别名：`flowpilot`
- 物理路径：部署后的 `dist` 文件目录
- 应用程序池：独立应用程序池
- .NET CLR：无托管代码
- 托管管道：集成
- 文件权限：应用程序池身份至少具有读取和执行权限

服务器需要安装 IIS 静态内容、默认文档和 URL Rewrite Module。仓库中的 `public/web.config` 会在构建时复制到 `dist`，负责默认文档和 React Router 深链接回退。

主站已有重写规则时，应确认 FlowPilot 应用形成独立配置边界。FlowPilot 的 `web.config` 会清除继承的规则，防止主站 SPA 或其他网站的重写规则抢先处理请求。

## 3. 正式 API 代理

正式前端请求地址为：

```text
http://服务器/api/v1/...
```

反向代理规则应配置在主站级别，并位于主站自身的 SPA 回退规则之前。后端只监听 `127.0.0.1`，不直接向局域网开放。代理需要保留请求方法、请求体、`Authorization`、Cookie、`Origin`、`Referer`、`ETag`、`If-Match` 和 `Range` 等请求头，并透传状态码、`Set-Cookie`、`Content-Type`、`Content-Disposition`、`ETag`、`Content-Range` 和 Problem Details 响应。

当前正式部署允许 HTTP，但登录密码和会话在内网链路上没有传输加密；切换 HTTPS 后应同步启用 Secure Cookie。

正式后端还需配置公司 AD/LDAP 域认证提供方。普通用户默认按域账号密码认证，密码登录用户和系统内置超级管理员使用 FlowPilot 本地密码；域服务异常时不得回退本地密码。部署验证至少覆盖一个域用户、一个普通密码用户和超级管理员，并确认超级管理员模拟域用户时无需目标用户密码即可返回模拟会话。域连接优先使用 LDAPS，域地址、绑定凭据和证书信任信息只能放在 Windows 服务配置或部署密钥中。

## 4. 部署验证

静态与路由：

```text
/flowpilot/
/flowpilot/login
/flowpilot/tasks
/flowpilot/processes
/flowpilot/processes/{id}/print
```

正式包额外验证：

```text
/api/v1/health
```

检查浏览器 Network：静态资源应从 `/flowpilot/assets/...` 返回 200；正式 API 应返回 JSON 或文件内容，不得返回 `index.html`；debug 包的 `/flowpilot/mock-api/v1/...` 应显示为页面内 Mock 响应且不产生 IIS 请求日志。

重新部署后如页面仍加载旧版本，应清除浏览器缓存并确认 `index.html` 已更新。不要清理站点全部 localStorage 或 IndexedDB，除非确认要删除当前浏览器的演示数据和附件。
