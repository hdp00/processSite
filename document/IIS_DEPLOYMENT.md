# FlowPilot IIS 与 .NET Windows Service 部署指南

> 目标环境：Windows Server 2016、IIS、公司内网 HTTP、SQL Server 2016 SP2 及之后版本（兼容级别不低于 130）
> 状态：目标部署设计；仓库现有 NestJS 骨架尚未迁移为 .NET 10，当前不能按本文直接投产。

## 1. 部署拓扑

- IIS 托管 `/flowpilot` 前端静态文件。
- IIS/ARR 把同源 `/api/flowpilot/*` 反向代理到 `http://127.0.0.1:<API_PORT>`。
- ASP.NET Core 10/Kestrel 作为原生 Windows Service 运行，只监听 loopback。
- SQL Server、LDAP、SMTP 和附件目录只能由服务账号访问，浏览器与 IIS 应用池不能直接访问。
- 不使用 WinSW，也不把 Kestrel 直接暴露到局域网。

当前 Windows Server 2016 与 SQL Server 2016 SP2 部署的生命周期风险已经接受，本项目不制定升级计划；支持较新的 SQL Server 版本只是兼容能力。部署仍须实施内网隔离、最小权限、受信 TLS、适用补丁、备份恢复和审计。

## 2. 前置条件

- Windows Server 2016 x64 与 IIS，启用“静态内容”和“默认文档”。
- IIS URL Rewrite Module 与 ARR Proxy。
- .NET 10 运行条件：框架依赖发布需安装匹配的 .NET 10 Runtime；自包含发布无需全局 Runtime。最终选择必须在目标服务器验证并固化到发布清单。
- SQL Server 2016 13.x SP2/SP3 或主版本 14 及以上，目标数据库兼容级别不低于 130，启用 TCP/IP 和 SQL 登录。
- 独立低权限 Windows 服务账号、独立 IIS 应用程序池账号。
- DBA 提供分离的迁移账号和最小 DML 运行账号；常驻账号不得拥有 `sysadmin` 或 DDL 权限。

## 3. 目录规划

部署时确定 `{部署根目录}`，但不固定盘符或上级路径。程序统一放在 `App` 下；每个发布目录是不可变的 API/Web 完整组合，`current` 与 `previous` 是本机 NTFS 目录联接：

```text
{部署根目录}/
├─ flowpilot.root                  部署根标记，不含秘密
├─ App/
│  ├─ current/                     -> releases/2026.08.26.2
│  ├─ previous/                    -> releases/2026.08.10.1
│  └─ releases/
│     ├─ 2026.08.10.1/
│     │  ├─ api/
│     │  │  ├─ FlowPilot.Api.exe
│     │  │  ├─ FlowPilot.Api.dll
│     │  │  └─ appsettings.json
│     │  ├─ web/
│     │  └─ release.json
│     └─ 2026.08.26.2/
│        ├─ api/
│        ├─ web/
│        └─ release.json
├─ Config/
│  └─ appsettings.Production.json
├─ Secrets/
│  └─ secrets.Production.json
├─ Data/
│  └─ Attachments/
│     ├─ 2026/
│     ├─ 2027/
│     └─ ...
├─ Logs/
├─ Temp/
└─ Backup/
```

`current` 和 `previous` 必须同时指向包含 `api` 与 `web` 的完整发布包，不能为前后端分别设置链接。Windows Service 的稳定路径是 `{部署根目录}\App\current\api\FlowPilot.Api.exe`，IIS `/flowpilot` 的稳定物理路径是 `{部署根目录}\App\current\web`。

Config、Secrets、Data、Logs、Temp 和 Backup 都在 `App` 之外。发布、回滚或清理只新增或清理 `App\releases` 中明确识别的物理发布目录，不得移动、覆盖或删除这些持久化目录。清理工具不得跟随目录联接递归删除目标，也不得删除 `current` 或 `previous` 正在引用的发布。附件目录不能位于 IIS 物理目录，也不能配置为虚拟目录或静态资源路径。

`flowpilot.root` 是不含账号、地址或密码的普通标记文件，部署时由管理员在选定部署根创建为空文件，并设置为服务账号和 IIS 账号只读、部署管理员可修改。API 从 `AppContext.BaseDirectory` 开始，包含当前目录在内最多检查 6 层祖先目录，必须且只能找到一个该标记。启动时还要验证部署根不是磁盘根、当前 API 和目录联接目标均位于本机 `App\releases` 边界内。此规则同时兼容 `App\current\api` 和文件系统解析后的 `App\releases\{releaseId}\api`；不得固定取父目录，不使用当前工作目录或路径环境变量。

附件 GUID 使用小写 32 位 `attachmentIdN`，`shard` 固定取其前两位。正式附件使用 `Data\Attachments\{yyyy}\objects\{shard}\{attachmentIdN}`，上传中的文件使用同一年目录下的 `.incoming\{attachmentIdN}.part`；年份按 `Asia/Shanghai` 创建时间固化。数据库仅保存相对键，不保存绝对路径，原始文件名和扩展名不参与物理路径。

## 4. 构建与发布包

前端从仓库根目录构建：

```powershell
pnpm install --frozen-lockfile
pnpm build
```

前端产物复制到新发布暂存目录的 `web`，后端产物复制到同一发布暂存目录的 `api`。正式前端固定请求同源 `/api/flowpilot/v1`，不包含浏览器 Mock。

.NET 后端完成后，从 solution 目录执行类似命令：

```powershell
dotnet restore --locked-mode
dotnet test -c Release --no-restore
dotnet publish src/FlowPilot.Api/FlowPilot.Api.csproj -c Release -r win-x64 --no-restore -o <发布暂存目录>
```

是否使用 `--self-contained true` 在首次服务器验证后固定。发布包不得包含真实 Config/Secrets、测试产物、SDK、迁移账号、数据库备份或附件。完整暂存包至少包含 `api`、`web` 和 `release.json`；releaseId 建议采用不会与 REST `/v1` 混淆的不可变编号，如 `2026.08.26.2`，不得覆盖已存在目录。

`release.json` 至少记录 releaseId、产品版本、构建时间、源代码提交、API 契约版本、所需数据库结构版本、允许兼容的结构版本范围、迁移校验和及文件校验信息。暂存包完成测试、哈希和病毒扫描后，复制为新的 `App\releases\{releaseId}`；目录落地后保持不可变。

## 5. 外置配置

配置文件：

- `{部署根目录}\App\current\api\appsettings.json`：随版本发布，只含稳定、非敏感默认值。
- `{部署根目录}\Config\appsettings.Production.json`：环境非敏感值及显式覆盖。
- `{部署根目录}\Secrets\secrets.Production.json`：SQL Server、LDAP、SMTP 地址与凭据、首次超级管理员密码。

配置值优先级为：标准 .NET 进程环境变量 > Secrets JSON > Config JSON > 默认 appsettings。目录和文件位置不允许被环境变量覆盖；不再设置或支持 `FLOWPILOT_HOME`、`FLOWPILOT_CONFIG_FILE`、`FLOWPILOT_SECRETS_FILE`。应用显式加载上述两个固定外置 JSON 文件，缺失或无读取权限时拒绝就绪。

Secrets 是明文 JSON，不使用 DPAPI、Data Protection 密钥文件或外部秘密平台。只允许服务账号读取、指定部署管理员修改；禁止提交 Git、复制到 IIS 目录或写入日志。首次初始化成功后从 Secrets 删除超级管理员初始密码。

SQL Server 连接字符串必须显式设置连接安全参数、`Connection Timeout`、`Min Pool Size` 和 `Max Pool Size`。远程数据库默认使用 `Encrypt=true;TrustServerCertificate=false`，并由服务账号信任与服务器名称匹配的证书链；不得依赖 Microsoft.Data.SqlClient 的版本默认值。只有 API 与 SQL Server 确认使用同机 `127.0.0.1` 且部署记录批准时，才允许配置例外。连接测试、健康检查和日志不得输出服务器地址、完整连接字符串或证书明细。

数据库命令超时属于非敏感配置，统一放在 `FlowPilot:Database`：`ApplicationCommandTimeoutSeconds` 默认 30、`ReadinessCommandTimeoutSeconds` 默认 5、`SchemaProbeCommandTimeoutSeconds` 默认 15、`MigrationPreflightCommandTimeoutSeconds` 默认 15、`MigrationCommandTimeoutSeconds` 默认 300。每项只能配置为 1–3600 秒；`0` 会形成无限等待，因此启动或数据库工具必须拒绝。运行账号连接池上限需按单实例容量和 SQL Server 会话预算确认，生产 Secrets 示例默认 `Min Pool Size=0;Max Pool Size=100`。

外部 JSON 示例结构见 `BACKEND_IMPLEMENTATION_CHECKLIST.md`。站点根地址不配置：后端从通过同源校验的 Origin/Referer 与 IIS 覆盖后的协议/Host 得到 `${origin}/flowpilot`，并随邮件事件冻结。

## 6. 数据库初始化与升级

1. DBA 在受支持的 SQL Server 实例中创建数据库，设置不低于 130 的兼容级别和确认的排序规则；共享脚本始终以 SQL Server 2016 SP2/兼容级别 130 为能力基线。
2. 停止 API 服务。
3. 备份数据库与附件清单。
4. DBA 使用迁移账号执行已审核 SQL 脚本，并记录脚本版本与校验和。
5. 使用最小运行账号启动 API；服务只校验结构，不自动迁移。
6. 检查 `/health/ready` 和受保护的 `/health/details`。

应用不得在启动时调用 `Database.Migrate()` 或 `EnsureCreated()`。EF migration 作为开发和脚本生成依据；migration bundle 只有在组织决定采用并完成审查时才作为独立部署工具运行，绝不能由常驻 Windows 服务账号执行。

## 7. NTFS 权限

| 目录 | .NET 服务账号 | IIS 应用池账号 | 部署管理员 |
| --- | --- | --- | --- |
| `App\releases\*\api` 与 `App\current\api` | 读取/执行 | 无 | 修改 |
| `App\releases\*\web` 与 `App\current\web` | 无需 | 读取 | 修改 |
| `App\current`、`App\previous` | 读取/执行 | 读取 | 仅部署管理员切换 |
| `Config` | 读取 | 无 | 修改 |
| `Secrets` | 读取 | 无 | 修改 |
| `Data\Attachments` | 修改 | 无 | 修改/备份 |
| `Temp` | 修改 | 无 | 修改 |
| `Logs` | 修改 | 无 | 读取/维护 |
| `Backup` | 按备份流程 | 无 | 修改 |

移除继承后再授予最小权限。服务账号不要加入 Administrators；IIS 应用池不得读取 Config、Secrets、Data、Logs 或 Backup。

## 8. 注册原生 .NET Windows Service

ASP.NET Core 工程必须调用 `AddWindowsService`/等价宿主配置，并使用 `Microsoft.Extensions.Hosting.WindowsServices`。Kestrel URL 固定为 loopback，例如 `http://127.0.0.1:3000`。

使用组织标准服务部署工具或 `sc.exe create` 注册 `{部署根目录}\App\current\api\FlowPilot.Api.exe`，服务启动类型为 Automatic（Delayed Start），登录账号为专用服务账号。服务命令行和环境变量不需要包含根目录、Config 或 Secrets 路径，也不得包含秘密。

配置 Windows 服务恢复策略：首次、第二次及后续失败按受控退避重启，连续失败保留事件日志并告警。注册后先在服务器本机验证：

```powershell
Invoke-WebRequest http://127.0.0.1:3000/api/flowpilot/v1/health/live
Invoke-WebRequest http://127.0.0.1:3000/api/flowpilot/v1/health/ready
```

只有两个接口符合预期后才启用 IIS 代理。Windows 服务当前工作目录可以与 API 目录不同；应用必须从 `AppContext.BaseDirectory` 向上有限查找唯一 `flowpilot.root`，不得调用 `Directory.GetCurrentDirectory()` 或固定取父目录推导部署路径。

## 9. 创建 IIS 前端应用

在现有 IIS 主站下创建 `/flowpilot` 应用：

- 物理路径：`{部署根目录}\App\current\web`
- 独立应用程序池，No Managed Code
- 关闭目录浏览
- `index.html` 返回 `Cache-Control: no-cache`
- 带内容哈希的 JS/CSS 可长缓存
- `/flowpilot` 保留查询参数重定向到 `/flowpilot/`
- SPA 回退只处理前端路由，不接管 `/api/flowpilot/*` 或 `/flowpilot/mock-api/*`

生产前端只使用 `/api/flowpilot/v1`。`pnpm build:debug` 是单浏览器演示包，不接入真实数据库或多人环境。

## 10. IIS/ARR 反向代理

在主站、SPA 回退之前建立 `/api/flowpilot/*` 代理规则，目标为 `http://127.0.0.1:3000/{R:0}` 或按实际端口配置。

必须满足：

- 只代理 `/api/flowpilot/*`，不接管同站其他系统 API。
- IIS 明确限制允许的内外网 Host/IP 绑定，并在反代前拒绝未知 Host。
- 删除外部请求提供的 `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto`，再分别写入 IIS 看到的真实客户端 IP、当前匹配的 Host 与 `http`。
- 不追加、不透传外部转发头。ASP.NET Core `ForwardedHeadersMiddleware` 只信任 loopback 代理。
- ARR/Kestrel 上传大小、请求超时与后端限制一致；附件下载允许单 Range。

当前环境是 HTTP，所以 Cookie `Secure=false`，但仍使用 HttpOnly、SameSite=Strict 和 Origin/Referer 同源校验。如果将来另行启用 HTTPS，再把 Proto 固定为 `https` 并启用 Secure Cookie；本项目当前不包含该升级工作。

## 11. 日志与健康检查

Serilog 写入 `{部署根目录}\Logs` 的滚动 JSON 文件，按日期和大小切分，默认保留 30 天。Windows Event Log 仅记录服务生命周期和无法创建文件日志等早期故障。禁止记录密码、Cookie/会话令牌、连接字符串、完整表单内容、附件正文和 SMTP/LDAP 凭据。

- `/health/live`：匿名，只证明进程存活。
- `/health/ready`：匿名且脱敏，验证数据库/结构和附件硬条件。
- `/health/details`：需要系统运维权限，显示 SQL、LDAP、SMTP、磁盘、Outbox/死信和后台租约的脱敏状态。

LDAP 或 SMTP 异常通常是降级；数据库不可用、结构版本不匹配或附件根目录硬条件失败使服务不就绪。

## 12. 首次上线验收

- 前端 `/flowpilot/`、收藏链接、刷新路由、静态缓存和正式 API 正常。
- `/api/flowpilot/v1` 只经 IIS 可达，Kestrel 端口不能从局域网访问。
- Cookie、Origin/Referer、未知 Host、Problem Details、ETag/If-Match 和幂等请求正常。
- 从两个客户端地址制造受控登录失败，确认限流桶不串用；伪造三个转发头，确认 IIS 全部覆盖且不能改变来源、同源判断或邮件入口。
- 用外置测试账号完成一次真实 LDAP 登录和一封测试邮件；Secrets 不出现在日志/响应。
- 验证上传中断、完整下载、206/416、无权限、磁盘保留、服务重启及附件清理恢复。
- 附件写入年份目录，例如 2026 年文件位于 `Data\Attachments\2026`，且不能通过 IIS 静态访问。
- 停止服务和 IIS 应用，将 `current` 从完整旧发布包统一切到完整新发布包并重新启动，确认 API/Web 版本一致且 Config/Secrets/Data/Logs/Temp/Backup 未被覆盖；随后按相同步骤切回 `previous` 验证回滚。
- 分别从 `App\current\api` 和实际 `App\releases\{releaseId}\api` 启动，并将 Windows Service 当前工作目录设置为其他位置，确认应用都能在 6 层上限内找到唯一 `flowpilot.root`；标记缺失、重复、超出深度或联接目标逃逸时必须拒绝就绪，旧 `FLOWPILOT_HOME` 等变量不得改变解析结果。
- 在真实 SQL Server 2016 SP2、兼容级别 130 最低基线以及实际部署的较新 SQL Server 版本/兼容级别上完成迁移、核心业务、并发和备份恢复演练。

## 13. 回滚与备份

允许计划停机，目录联接切换不作为零停机承诺。标准发布和回滚顺序如下：

1. 在 `App\releases` 中落地新的不可变发布目录，校验 `release.json`、文件哈希和 API/Web 完整性。
2. 对数据库做兼容预检；需要结构变更时停止服务、备份并由 DBA 执行已批准脚本。
3. 停止 FlowPilot Windows Service，并暂停或使 IIS `/flowpilot` 应用脱机。
4. 先创建指向新发布的临时目录联接并验证目标；保留旧发布，将 `previous` 指向旧目标，再把 `current` 切到新目标。Windows Server 2016 本机 NTFS 目录使用 [`mklink /J`](https://learn.microsoft.com/windows-server/administration/windows-commands/mklink)；不得指向网络共享或 `App\releases` 之外。
5. 启动服务和 IIS，依次检查 live、ready、数据库结构、登录、关键流程和前端静态版本。
6. 验证失败时，先停止服务和 IIS；只有数据库仍与旧程序兼容，或 DBA 已完成批准的恢复方案，才能把 `current` 指回 `previous` 后重新启动。

首次安装没有旧发布时，只创建 `current`，不得创建指向不存在目标的 `previous`。升级成功并完成观察后，至少保留 `current` 和 `previous` 对应的两个完整发布目录；清理更旧版本前必须解析并核对全部联接目标，不能跟随联接递归清理。切换期间已经打开的浏览器可能仍持有旧版入口或延迟加载资源，上线验收应关闭并重新打开页面或执行强制刷新；前后端版本不匹配时前端应提示刷新，不能继续提交写操作。

链接回滚只恢复 API 与 Web 文件，不恢复数据库结构和业务数据。禁止通过 `git reset`、覆盖外置目录或手工删除迁移记录回滚生产数据，也不得直接覆盖正在运行的 release 目录。

首版不提供应用内自动备份。DBA 负责 SQL Server 备份；应用生成同一停机时间点的附件清单和 SHA-256，运维复制附件目录。数据库和附件必须作为同一恢复点管理。
