# FlowPilot IIS 部署说明

## 1. 构建模式

部署前必须先确定数据来源，两种包不能混用：

```bash
# 正式部署：读取真实后端 /api/flowpilot/v1
pnpm build

# HTTP 原型演示：使用页面内 Mock 数据
pnpm build:debug
```

两种命令的输出目录均为 `apps/web/dist`，后执行的构建会覆盖前一次产物。部署时复制 `dist` 目录内的全部文件，而不是复制 `dist` 目录本身。

debug 包不注册 Service Worker，不要求 HTTPS。其流程状态保存在浏览器 localStorage，PDF、附件和富媒体正文保存在 IndexedDB；不同浏览器、电脑、域名、协议或端口之间不共享数据。

正式包不包含 Mock 代码，默认请求同源 `/api/flowpilot/v1`。IIS 主站只将 `/api/flowpilot/*` 反向代理到监听 `127.0.0.1` 的后端服务；如果后端地址不同，应在正式构建前调整 `.env.production` 的 `VITE_API_BASE_URL`。

## 2. 服务器目录与持久化数据

正式部署必须把版本化代码与业务数据分开：

```text
{FLOWPILOT_HOME}\
├─ {实际程序目录名称}\
│  ├─ web\
│  └─ api\
├─ Config\
│  └─ application.env
├─ Secrets\
│  └─ production.env
├─ Data\
│  └─ Attachments\
│     └─ 2026\
├─ Logs\
├─ Temp\
└─ Backup\
```

- `FLOWPILOT_APP_DIR` 是部署时选定的实际程序目录，不固定盘符、路径或目录名称；以后发布、回滚和清理程序只操作该目录。`Config`、`Secrets`、`Data`、`Logs`、`Temp` 和 `Backup` 都是其同级持久化目录，不放进发布包，也不能位于 IIS 网站物理目录内。
- `FLOWPILOT_HOME` 根据 `FLOWPILOT_APP_DIR` 的父目录动态确定。部署脚本和 Windows 服务注册信息必须提供或可靠定位实际程序目录，不得依赖 Windows 服务当前工作目录推导路径。
- 附件根目录固定由根目录推导为 `{FLOWPILOT_HOME}\Data\Attachments`，内部继续按 `{yyyy}/.incoming` 和 `{yyyy}/objects` 分层，不单独配置 `ATTACHMENT_ROOT`。
- `Config\application.env` 保存非敏感运行参数；AD/LDAP、SMTP、SQL Server 账号连接信息和首次初始化超级管理员密码集中保存在明文 `Secrets\production.env`。首版不使用 DPAPI 或外部密钥平台，必须通过 NTFS 权限限制为 NestJS 服务账号只读、指定部署管理员可修改，并禁止提交 Git 或复制进程序发布包。
- 配置键、默认运行参数和部署人员后续填写项统一见 [`BACKEND_IMPLEMENTATION_CHECKLIST.md`](./BACKEND_IMPLEMENTATION_CHECKLIST.md)。仓库示例只能保留 `<占位值>`，不得写入真实主机、域名、账号或密码。
- 禁止把附件根目录放在 `App`、后端工作目录、IIS 网站目录或系统临时目录中。后端启动时应规范化并校验实际路径，违反边界时拒绝就绪。
- IIS 不得为附件目录建立虚拟目录、静态映射或目录浏览，客户端只能通过 `/api/flowpilot/v1` 的受控附件接口访问正文。

权限建议：

| 目录 | NestJS Windows 服务账号 | IIS 应用程序池身份 |
| --- | --- | --- |
| `{FLOWPILOT_APP_DIR}/api` | 读取和执行 | 无权限 |
| `{FLOWPILOT_APP_DIR}/web` | 无需写入 | 读取和执行 |
| `Config` | 读取 | 无权限 |
| `Secrets` | 读取 | 无权限 |
| `Data/Attachments` | 修改 | 无权限 |
| `Logs`、`Temp` | 修改 | 无权限 |
| `Backup` | 按备份流程单独授权 | 无权限 |

整体更换 `FLOWPILOT_HOME` 的盘符或路径时，先停止 NestJS Windows 服务，再复制持久化目录，按数据库清单核对附件数量、大小和 SHA-256；校验通过后修改根目录配置，启动服务并运行附件完整性检查。数据库只保存相对存储键，因此改变根目录或盘符不需要批量更新附件记录；校验失败时继续使用旧目录。

## 3. NestJS Windows 服务

- 服务器安装 Node.js 24 LTS x64，并使用仓库规定的具体补丁版本。Node.js 官方平台基线包含 Windows Server 2016 x64，但仍必须在目标服务器执行启动、SQL 驱动、scrypt 参数与并发内存、LDAP、Axios 受控 HTTP 调用、SMTP、文件流和服务重启冒烟测试。生产依赖不得要求 node-gyp、Visual Studio、ODBC 或运行时下载原生二进制文件。
- 后端发布目录为 `{FLOWPILOT_APP_DIR}\api`，包含编译产物、生产依赖、WinSW 可执行文件及不含秘密的服务模板。配置和秘密文件仍从父目录读取，不复制进发布目录。
- 使用 WinSW 将 `node.exe` 和后端入口包装为 Windows 服务，服务名建议固定为 `FlowPilotApi`，监听 `127.0.0.1:3000`。WinSW 配置必须把 `FLOWPILOT_APP_DIR` 设为实际绝对路径，不能依赖当前工作目录。
- 应用使用 `nestjs-pino` 把 JSON Lines 写到标准输出；WinSW 按日期和大小把标准输出/错误滚动到 `{FLOWPILOT_HOME}\Logs`。日志默认保留30天，不记录密码、Cookie、令牌、连接字符串、完整表单和附件正文。
- 服务账号使用独立低权限 Windows 账号。注册后配置异常退出自动重启和退避；数据库结构落后属于服务可运行但不就绪，不得通过自动迁移绕过。

首次部署顺序：

1. 创建实际程序目录及同级 `Config`、`Secrets`、`Data`、`Logs`、`Temp`、`Backup`，设置 NTFS 权限。
2. 复制前端和后端发布产物；从示例创建服务器外置配置并填写真实环境值。
3. 停止服务或保持尚未注册，使用独立迁移账号执行结构预检和 Migration。
4. 执行首次种子命令，创建内置权限、角色和超级管理员；成功后删除首次初始化密码配置项。
5. 注册并启动 WinSW 服务，先验证 `/health/live` 和 `/health/ready`，再配置或启用 IIS 代理。

升级顺序固定为：停止 Windows 服务、DBA 备份数据库、生成同一停机点附件清单、替换版本化程序目录、执行迁移、启动服务、检查三个健康接口和核心业务冒烟。回滚前必须判断数据库 Migration 是否仍与旧程序兼容；不能只替换程序文件后直接启动。

## 4. IIS 应用

在现有主站下创建或转换 IIS 应用：

- 别名：`flowpilot`
- 物理路径：`{FLOWPILOT_APP_DIR}\web`，内容来自正式构建的 `dist`；部署时替换为实际绝对路径
- 应用程序池：独立应用程序池
- .NET CLR：无托管代码
- 托管管道：集成
- 文件权限：应用程序池身份至少具有读取和执行权限

服务器需要安装 IIS 静态内容、默认文档和 URL Rewrite Module。仓库中的 `public/web.config` 会在构建时复制到 `dist`，负责默认文档和 React Router 深链接回退。

主站已有重写规则时，应确认 FlowPilot 应用形成独立配置边界。FlowPilot 的 `web.config` 会清除继承的规则，防止主站 SPA 或其他网站的重写规则抢先处理请求。

访问不带末尾斜杠的 `/flowpilot` 时，应用会永久重定向到 `/flowpilot/`，因此两个地址都可以作为入口使用。若服务器在进入 FlowPilot 子应用前就由主站处理了 `/flowpilot`，需在主站重写规则最前面增加同等的 `/flowpilot` → `/flowpilot/` 重定向，并确保它位于主站 SPA 回退之前。

## 5. 正式 API 代理

正式前端请求地址为：

```text
http://服务器/api/flowpilot/v1/...
```

反向代理规则应配置在主站级别，并位于主站自身的 SPA 回退规则之前。建议使用以下路径范围，不能用宽泛的 `/api/*` 抢占同一主站其他系统的接口：

```xml
<rule name="FlowPilot API" stopProcessing="true">
  <match url="^api/flowpilot/(.*)$" />
  <action type="Rewrite"
          url="http://127.0.0.1:3000/api/flowpilot/{R:1}"
          appendQueryString="true" />
</rule>
```

后端只监听 `127.0.0.1`，不直接向局域网开放。代理需要保留请求方法、请求体、Cookie、`Origin`、`Referer`、`ETag`、`If-Match` 和 `Range` 等请求头，并透传状态码、`Set-Cookie`、`Content-Type`、`Content-Disposition`、`Content-Length`、`Accept-Ranges`、`ETag`、`Content-Range` 和 Problem Details 响应。正式认证不使用 Authorization Bearer；Debug Mock 请求也不会进入 IIS。

当前正式部署允许 HTTP，但登录密码和会话在内网链路上没有传输加密；切换 HTTPS 后应同步启用 Secure Cookie。

正式后端还需配置公司 AD/LDAP 域认证提供方。普通用户默认按域账号密码认证，密码登录用户和系统内置超级管理员使用 FlowPilot 本地密码；域服务异常时不得回退本地密码。部署验证至少覆盖一个域用户、一个普通密码用户和超级管理员，并确认超级管理员模拟域用户时无需目标用户密码即可返回模拟会话。域连接优先使用 LDAPS，域地址、绑定凭据和证书信任信息只能放在服务器的 `Secrets\production.env` 中。

## 6. 部署验证

静态与路由：

```text
/flowpilot/
/flowpilot（应重定向到 /flowpilot/）
/flowpilot/login
/flowpilot/tasks
/flowpilot/processes
/flowpilot/processes/{id}/print
```

正式包额外验证：

```text
/api/flowpilot/v1/health/live
/api/flowpilot/v1/health/ready
/api/flowpilot/v1/health/details（未登录应为 401；具有运维权限后返回脱敏详情）
```

检查浏览器 Network：静态资源应从 `/flowpilot/assets/...` 返回 200；正式 API 应返回 JSON 或文件内容，不得返回 `index.html`；debug 包的 `/flowpilot/mock-api/v1/...` 应显示为页面内 Mock 响应且不产生 IIS 请求日志。

正式附件验证还应覆盖：附件实际写入 `{FLOWPILOT_HOME}\Data\Attachments\{yyyy}`；IIS 应用程序池账号不能读取附件目录；直接构造静态附件路径返回不可访问；正常用户只能通过 API 下载有权限的附件；合法单区间返回 `206`、非法或多区间返回 `416`；模拟磁盘保留空间不足返回 `507`；替换实际程序目录内容后历史附件仍可读取。

重新部署后如页面仍加载旧版本，应清除浏览器缓存并确认 `index.html` 已更新。不要清理站点全部 localStorage 或 IndexedDB，除非确认要删除当前浏览器的演示数据和附件。
