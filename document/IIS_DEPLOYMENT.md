# FlowPilot IIS 部署指南

FlowPilot 固定部署在 `/flowpilot/`。可选择以下一种方式：

- **正式环境**：IIS 托管前端，NestJS 作为 Windows 服务运行，IIS 将 `/api/flowpilot/*` 反向代理到 `127.0.0.1:3000`。
- **Mock 演示**：只部署前端，数据保存在当前浏览器的 `localStorage` 和 IndexedDB 中，不需要后端、SQL Server 或 HTTPS。

两种构建都会写入 `apps/web/dist`，后一次构建会覆盖前一次，部署时不要混用。

## 1. 部署前准备

正式环境需要：

- IIS：启用“静态内容”和“默认文档”。
- IIS URL Rewrite Module；正式环境还需 ARR 反向代理。
- Node.js 24 LTS x64。
- SQL Server 2016 SP2 或更高版本，数据库兼容级别不低于 130。
- 独立的 IIS 应用程序池账号和 NestJS Windows 服务账号。

先确定程序目录 `{FLOWPILOT_APP_DIR}`。以下目录结构中的名称和盘符可按实际环境调整，但持久化目录必须与程序目录同级：

```text
{FLOWPILOT_HOME}\
├─ {FLOWPILOT_APP_DIR名称}\
│  ├─ web\
│  └─ api\
│     └─ config\defaults.env
├─ Config\application.env
├─ Secrets\production.env
├─ Data\Attachments\
├─ Logs\
├─ Temp\
└─ Backup\
```

`Config`、`Secrets`、`Data`、`Logs`、`Temp` 和 `Backup` 不得放入 IIS 网站目录或随版本覆盖。附件不得通过 IIS 虚拟目录或静态映射公开。

## 2. 构建

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
```

正式环境：

```powershell
pnpm build
```

Mock 演示：

```powershell
pnpm build:web_mock
```

构建结果：

- 前端：`apps/web/dist`。将该目录内的全部内容复制到 `{FLOWPILOT_APP_DIR}\web`。
- 后端：`apps/api/dist`。正式发布包还必须包含 `apps/api/config/defaults.env` 和生产依赖，目标服务器必须已安装 Node.js 运行时。

仓库当前没有自动组装 WinSW/生产依赖发布包的脚本。部署前应按组织的发布流程组装并验证后端包；不要只复制 `apps/api/dist`，否则运行时依赖无法加载。

## 3. 配置正式后端

从仓库模板创建外置配置：

```text
apps/api/config/application.env.example
  → {FLOWPILOT_HOME}\Config\application.env

apps/api/config/production.env.example
  → {FLOWPILOT_HOME}\Secrets\production.env
```

- `application.env`：数据库排序规则及必要的非敏感覆盖项。
- `production.env`：SQL Server、LDAP、SMTP 地址、账号和密码。
- `api\config\defaults.env`：随版本发布的稳定默认值，不要写入环境地址或秘密。
- 配置优先级：进程环境变量 > `production.env` > `application.env` > `defaults.env`。

`production.env` 是明文秘密文件。只允许 NestJS 服务账号读取、指定部署管理员修改，禁止提交 Git、复制到 IIS 目录或写入日志。密码包含 `#`、空格或前后空白时应保留模板中的引号。

首次部署时临时填写 `FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD`。完成种子初始化后，立即从 `production.env` 删除该项。

数据库由 DBA 预先创建。服务不会自动建库、自动迁移或自动修改结构。使用迁移账号执行：

```powershell
node dist/database/cli/migrate.js
node dist/database/cli/seed.js
```

执行目录为 `{FLOWPILOT_APP_DIR}\api`，并确保进程环境变量 `FLOWPILOT_APP_DIR` 指向该绝对路径。常驻运行账号只授予 `flowpilot` schema 所需权限，不使用 `sysadmin`。

SQL Server 远程连接应在 `application.env` 明确启用加密并校验证书：

```text
MSSQL_ENCRYPT=true
MSSQL_TRUST_SERVER_CERTIFICATE=false
```

仅当 API 与 SQL Server 确认同机且通过 `127.0.0.1` 连接时，才可在记录风险后使用未加密或信任服务器证书的例外配置。

完整配置项见 [后端实施检查清单](./BACKEND_IMPLEMENTATION_CHECKLIST.md)。

## 4. 注册 NestJS Windows 服务

使用 WinSW 将以下命令注册为 Windows 服务：

```text
node.exe dist/main.js
```

建议配置：

- 服务名：`FlowPilotApi`。
- 工作目录：`{FLOWPILOT_APP_DIR}\api`。
- 环境变量：`FLOWPILOT_APP_DIR={FLOWPILOT_APP_DIR绝对路径}`。
- 服务账号：独立低权限 Windows 账号。
- 监听地址：`127.0.0.1:3000`，不要直接向局域网开放。
- 日志目录：`{FLOWPILOT_HOME}\Logs`，按日期和大小滚动，默认保留 30 天。
- 恢复策略：异常退出后自动重启并设置退避。

仓库当前不包含 WinSW 可执行文件或服务 XML，需由部署环境提供。注册后先在服务器本机验证：

```text
http://127.0.0.1:3000/api/flowpilot/v1/health/live
http://127.0.0.1:3000/api/flowpilot/v1/health/ready
```

两个接口正常后再启用 IIS 代理。

## 5. 创建 IIS 应用

在现有 IIS 主站下创建应用：

- 别名：`flowpilot`。
- 物理路径：`{FLOWPILOT_APP_DIR}\web`。
- 应用程序池：独立应用程序池，“.NET CLR 版本”选择“无托管代码”，托管管道使用“集成”。
- 文件权限：应用程序池身份仅需读取和执行 `web` 目录。

构建产物中的 `web.config` 已处理以下内容：

- `/flowpilot` 永久重定向到 `/flowpilot/`，并保留查询参数。
- React Router 深链接回退到 `index.html`。
- `index.html` 禁用客户端缓存；带内容哈希的静态资源正常缓存。
- 清除从主站继承的重写规则，避免被其他 SPA 规则抢先处理。

如果主站在请求进入子应用前已处理 `/flowpilot`，应把同样的末尾斜杠重定向放在主站 SPA 回退规则之前。

## 6. 配置正式 API 代理

此步骤仅用于正式环境。先在服务器级 URL Rewrite“允许的服务器变量”中加入：

```text
HTTP_X_FORWARDED_FOR
HTTP_X_FORWARDED_HOST
HTTP_X_FORWARDED_PROTO
```

在 IIS **主站**的重写规则中添加以下规则，并放在主站 SPA 回退之前：

```xml
<rule name="FlowPilot API" stopProcessing="true">
  <match url="^api/flowpilot/(.*)$" />
  <serverVariables>
    <set name="HTTP_X_FORWARDED_FOR" value="{REMOTE_ADDR}" />
    <set name="HTTP_X_FORWARDED_HOST" value="{HTTP_HOST}" />
    <set name="HTTP_X_FORWARDED_PROTO" value="http" />
  </serverVariables>
  <action type="Rewrite"
          url="http://127.0.0.1:3000/api/flowpilot/{R:1}"
          appendQueryString="true" />
</rule>
```

同时完成以下设置：

1. 只保留实际使用的 IP、主机名和端口绑定，并在反代前拒绝未知 `Host`；不要让通配站点接收任意主机名。
2. 必须覆盖客户端传入的三个 `X-Forwarded-*` 头，不能追加或信任客户端原值。
3. 代理应保留 Cookie、请求体、`Origin`、`Referer`、`ETag`、`If-Match` 和 `Range`，并透传 `Set-Cookie`、文件下载头、Range 响应及 Problem Details。
4. 不要使用宽泛的 `/api/*` 规则，以免影响主站其他系统。

上例用于 HTTP。启用 HTTPS 时，把 `X-Forwarded-Proto` 固定为 `https`，并在 `application.env` 设置：

```text
FLOWPILOT_COOKIE_SECURE=true
```

如果同时保留 HTTP 和 HTTPS，应按实际绑定分别配置规则，不得接受客户端提交的协议头。HTTP 不加密登录密码和会话，只适用于已接受该风险的受控内网；公网必须使用 HTTPS 和可信 DNS 证书。

## 7. 目录权限

| 目录 | NestJS 服务账号 | IIS 应用程序池身份 |
| --- | --- | --- |
| `{FLOWPILOT_APP_DIR}\api` | 读取和执行 | 无权限 |
| `{FLOWPILOT_APP_DIR}\web` | 无需写入 | 读取和执行 |
| `Config`、`Secrets` | 读取 | 无权限 |
| `Data\Attachments`、`Logs`、`Temp` | 修改 | 无权限 |
| `Backup` | 按备份流程授权 | 无权限 |

## 8. 上线验证

### 通用检查

```text
/flowpilot/
/flowpilot/login
/flowpilot/tasks
/flowpilot/processes
/flowpilot/processes/{id}/print
```

- `/flowpilot` 应重定向到 `/flowpilot/`。
- `/flowpilot/assets/...` 应返回静态资源，不应返回 `index.html`。
- 页面刷新和深链接访问正常，无明显浏览器控制台错误。

### Mock 演示

- Network 中 `/flowpilot/mock-api/v1/...` 由页面内 Mock 处理，不应产生 IIS API 请求日志。
- 刷新后演示数据仍可读取。
- 不要清空整个 `localStorage` 或 IndexedDB，除非明确要删除当前浏览器的演示数据和附件。

### 正式环境

```text
/api/flowpilot/v1/health/live
/api/flowpilot/v1/health/ready
/api/flowpilot/v1/health/details
```

- `live` 和 `ready` 返回成功；`details` 未登录时返回 401，具有运维权限后只返回脱敏信息。
- 至少验证一个域用户、一个普通密码用户和系统超级管理员。
- 从两个不同客户端地址验证登录限流不会串用来源；伪造 `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto` 时，IIS 必须覆盖伪造值。
- 通过每个允许的站点入口执行一次写操作，确认同源校验通过；未知 `Host` 应在反代前被拒绝。
- 验证上传、下载、单区间 Range、无权限访问和服务重启；附件应写入 `{FLOWPILOT_HOME}\Data\Attachments`，且不能通过 IIS 静态路径访问。

## 9. 升级与回滚

升级按以下顺序执行：

1. 停止 `FlowPilotApi` 服务。
2. 由 DBA 备份数据库，并生成同一停机点的附件清单。
3. 备份当前程序目录，只替换 `{FLOWPILOT_APP_DIR}` 中的版本化程序；不要覆盖同级持久化目录。
4. 使用迁移账号执行数据库迁移。
5. 启动服务，检查健康接口、登录、流程处理和附件下载。

回滚前必须确认旧程序与当前数据库结构兼容。不能只替换程序文件后直接启动；数据库或附件校验失败时，应继续使用上一版本程序和原持久化目录。
