# FlowPilot .NET 后端实施决策与开工清单

> 状态：技术决策已确认；旧 NestJS 骨架已删除，.NET 分层工程与首个健康检查/数据库预检切片已开始实现。未勾选项仍是后续完整后端的验收要求。
> 注意：真实账号、地址、密码和安装路径由部署人员在后端完成后填写，不进入仓库或发布包。

## 1. 固定技术与工程结构

- [ ] `apps/api` 转换为 `net10.0` solution，按 Api/Application/Domain/Infrastructure/Contracts 与 tests 分层。
- [ ] ASP.NET Core 10 使用 Controller Web API；正式路径固定 `/api/flowpilot/v1`。
- [ ] 使用原生 .NET Windows Service + Kestrel loopback + IIS/ARR，不使用 WinSW。
- [ ] EF Core 10 + `Microsoft.EntityFrameworkCore.SqlServer` + `Microsoft.Data.SqlClient`，设置 `UseCompatibilityLevel(130)`。
- [ ] 支持 SQL Server 2016 SP2 及之后版本：13.x 接受 SP2/SP3，主版本 14 及以上；数据库兼容级别最低为 130并允许更高值。共享实现以 2016 SP2/兼容级别 130 为最低能力基线；不开发 SQLite 或数据库切换层。
- [ ] 当前 Windows Server 2016 与 SQL Server 2016 SP2 的生命周期风险记录为已接受；不建立升级计划。支持较新 SQL Server 版本不等于要求升级。
- [ ] 生产包不包含 SDK、测试、OpenAPI 生成器或数据库迁移账号。

## 2. 允许的直接依赖

- [ ] 数据：`Microsoft.EntityFrameworkCore.SqlServer`、`Microsoft.Data.SqlClient`；`Microsoft.EntityFrameworkCore.Design` 仅设计/开发使用。
- [ ] Windows 服务：`Microsoft.Extensions.Hosting.WindowsServices`。
- [ ] LDAP：`System.DirectoryServices.Protocols`。
- [ ] SMTP：`MailKit`/`MimeKit`。
- [ ] 日志：`Serilog.AspNetCore`、`Serilog.Sinks.File`。
- [ ] OpenAPI：`Microsoft.AspNetCore.OpenApi`。
- [ ] 对象映射：稳定版 `Riok.Mapperly`，以 `PrivateAssets="all"`、`ExcludeAssets="runtime"` 的私有编译期依赖引用，不使用 preview/next 版本。
- [ ] 测试：xUnit、`Microsoft.AspNetCore.Mvc.Testing`、`Microsoft.NET.Test.Sdk`。
- [ ] 优先使用内置 DI、Options、DataAnnotations、`System.Text.Json`、Health Checks、Rate Limiting、`BackgroundService`、`IHttpClientFactory`、Guid/加密/文件流。
- [ ] 不默认引入 Identity schema、Dapper、AutoMapper、MediatR、FluentValidation、Hangfire、Quartz.NET、Redis、消息队列、额外 DI 容器、NSwag 或服务器桩生成器。
- [ ] Axios 仅用于 Orval 前端客户端；后端外部调用只用命名/类型化 `IHttpClientFactory`。

## 3. OpenAPI 与 HTTP

- [ ] `document/flowpilot-rest-api.openapi.yaml` 继续作为唯一对外契约。
- [ ] Redocly lint 与 Orval TypeScript/Axios 生成可重复，重新生成无未提交差异。
- [ ] C# DTO 使用 DataAnnotations 和领域校验；`Microsoft.AspNetCore.OpenApi` 生成实现侧文档并与规范做语义比较。
- [ ] 正式 OpenAPI 只声明 `flowpilot_session` HttpOnly Cookie；Mock Bearer 不进入正式后端。
- [ ] 登录成功响应明确设置 `flowpilot_session`，注销响应明确清除同一路径 Cookie；二者及其他写请求都覆盖 403 CSRF 契约测试。
- [ ] Problem Details、稳定错误码、traceId、ETag/If-Match、Idempotency-Key、分页、任务中心 discriminator 和 `deepObject` 编码均有契约测试。
- [ ] 正式模式关闭 CORS；登录、注销及其他写请求的 Origin/Referer、可信转发头和未知 Host 规则按需求实现。

## 4. 外置配置

- [ ] 稳定非敏感默认值位于发布包 `appsettings.json`。
- [ ] 每个不可变的 `{部署根目录}\App\releases\{releaseId}` 同时包含 `api`、`web` 和 `release.json`；API 与 Web 不维护各自独立的 `current`。
- [ ] `App\current` 与 `App\previous` 使用指向本机 `App\releases` 内完整发布包的 NTFS 目录联接；Windows Service 固定指向 `current\api`，IIS 固定指向 `current\web`。
- [ ] 从 `AppContext.BaseDirectory` 开始最多检查 6 层祖先，必须且只能找到一个 `flowpilot.root`；禁止固定取父目录、使用 `Directory.GetCurrentDirectory()` 或 Windows Service 工作目录。
- [ ] 非敏感环境覆盖位于 `{部署根目录}\Config\appsettings.Production.json`。
- [ ] SQL/LDAP/SMTP 地址、账号、密码与初始超级管理员密码位于 `{部署根目录}\Secrets\secrets.Production.json`。
- [ ] 优先级为环境变量 > Secrets JSON > Config JSON > 默认 `appsettings.json`。
- [ ] 不支持 `FLOWPILOT_HOME`、`FLOWPILOT_CONFIG_FILE`、`FLOWPILOT_SECRETS_FILE` 或其他目录覆盖参数；标准环境变量只能覆盖配置值，不能改变目录和配置文件位置。
- [ ] 路径解析通过可注入接口隔离；生产实现验证部署根、App/releases 边界和目录联接目标，测试实现注入带根标记的独立临时目录。
- [ ] 外置真实 JSON、证书私钥、数据库备份和日志被 Git 忽略且不进入发布包；Secrets 仅服务账号可读、部署管理员可修改。
- [ ] 不实现 `.env` 解析、DPAPI、外部密钥平台或 Data Protection 密钥文件。
- [ ] Options 启动验证不向日志、健康接口或错误响应输出秘密。

部署后填写的配置组：

```json
{
  "ConnectionStrings": { "FlowPilot": "Server=<主机>;Database=<数据库>;User ID=<运行账号>;Password=<运行密码>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=15;Min Pool Size=0;Max Pool Size=100" },
  "FlowPilot": {
    "Database": {
      "ExpectedCollation": "<DBA 确认值>",
      "ApplicationCommandTimeoutSeconds": 30,
      "ReadinessCommandTimeoutSeconds": 5,
      "SchemaProbeCommandTimeoutSeconds": 15,
      "MigrationPreflightCommandTimeoutSeconds": 15,
      "MigrationCommandTimeoutSeconds": 300
    },
    "Ldap": { "Url": "<ldaps://...>", "BaseDn": "<...>", "UpnSuffix": "<...>" },
    "Smtp": { "Host": "<...>", "Port": 587, "UserName": "<...>", "Password": "<...>", "From": "<...>" },
    "Bootstrap": { "SuperAdminPassword": "<首次初始化临时值>" }
  }
}
```

示例只表达结构，真实值不得写入仓库。初始化成功后删除 `SuperAdminPassword`。

## 5. 数据库与迁移

- [ ] `flowpilot` schema、应用生成 `uniqueidentifier` 主键、UTC `datetime2(3)`、整数 revision、显式 CHECK/外键/唯一索引与规范化账号列。
- [ ] `DbContext` 持久化实体与领域模型/API DTO 分离。
- [ ] Entity/Domain/DTO 的结构映射使用 Mapperly；领域项目不引用 Mapperly，mapper 位于 Application、Infrastructure 或 Contracts 的边界项目。
- [ ] 创建/更新/PATCH DTO 不直接覆盖 EF 跟踪实体；主键、revision、状态、审计字段、密码和操作者只能由应用服务/领域行为赋值。
- [ ] Mapperly 严格未映射诊断提升为错误；有意忽略成员逐项声明，复杂转换使用显式手写 partial 方法。
- [ ] 普通 CRUD 用 EF Core；锁提示和复杂投影用参数化 SqlClient，并复用同一 DbConnection/DbTransaction。
- [ ] JSON 映射 `nvarchar(max)` + `ISJSON`；核心查询使用类型化投影表，不依赖 JSON 动态扫描。
- [ ] 禁止 `EnsureCreated()`、启动 `Database.Migrate()` 和运行账号 DDL 权限。
- [ ] 每次结构变更包含 EF migration、DBA 审查 SQL、空库/上一版测试、结构版本和校验和。
- [ ] 数据库启动预检验证：SQL Server 13.x 只接受 SP2/SP3，主版本 14 及以上接受；兼容级别不低于 130，并检查排序规则、schema 和结构版本。
- [ ] SQL 连接显式配置 `Encrypt=true;TrustServerCertificate=false` 并验证证书链和主机名；任何同机回环例外都已记录批准，日志和健康接口不输出连接字符串。
- [ ] 在真实 SQL Server 2016 SP2/兼容级别 130 最低基线和实际部署的较新版本/兼容级别上执行迁移、仓储、事务、锁、JSON、投影和死锁测试；不以 SQLite、EF InMemory 或单独的较新 SQL 版本替代最低基线。
- [ ] 权限组用途关联至少一项且不可重复；流程版本不保存与发布指针、校验结果重复的通用 status。
- [ ] 任务表和 API 区分审批、自由协作、重新提交；自由协作当前受理人、唯一 pending 任务、参与人投影、时间线和实例更新时间保持事务一致。
- [ ] 回复编辑只保留最新正文及编辑审计元数据，不存在保存旧正文的回复修订表或 API 字段。

## 6. 身份、会话与安全

- [ ] LDAP 使用 `System.DirectoryServices.Protocols`，默认 LDAPS，过滤器值转义，UPN bind 后唯一确认同一 sAM/UPN。
- [ ] 密码用户只使用 `PasswordHasher<TUser>`；`SuccessRehashNeeded` 时渐进重哈希；域用户密码散列为 NULL。
- [ ] 域故障不回退本地密码；密码用户成功、失败、停用均不探测 LDAP。
- [ ] 自定义数据库会话保存令牌散列；Cookie 闲置 8 小时、绝对 24 小时，停用/重置/登录方式变化使会话失效。
- [ ] 内置超级管理员唯一、不可删除/停用/改认证方式；初始密码只在账号不存在时使用。
- [ ] 使用 ASP.NET Core Rate Limiting；登录限流同时覆盖“账号+来源 IP”和 IP 总量，域不可用使用独立 IP 桶。
- [ ] IIS 覆盖外部 `X-Forwarded-For/Host/Proto`，ASP.NET Core 只信任 loopback；从两个来源和伪造头做验收。

## 7. 附件

- [ ] 部署根目录不写死；从 `AppContext.BaseDirectory` 向上有限查找唯一 `flowpilot.root`，同时覆盖 `current\api` 与真实 `releases\{releaseId}\api` 两种基目录。
- [ ] 附件根目录固定推导为 `{部署根目录}\Data\Attachments`；附件临时目录和正式对象目录分别为同卷 `{yyyy}\.incoming` 与 `{yyyy}\objects`，根目录 `Temp` 不用于附件状态机。
- [ ] 相对存储键按 `Asia/Shanghai` 固化年份；附件 GUID 使用小写 32 位 `attachmentIdN`，`shard` 取前两位，临时键 `{yyyy}/.incoming/{attachmentIdN}.part`，正式键 `{yyyy}/objects/{shard}/{attachmentIdN}`，并有兼容性测试。
- [ ] 流式上传同步计算 SHA-256；`uploading | staged | active | cleanup-pending | failed | deleted` 状态均持久化，普通业务 API 只暴露 `staged | active | cleanup-pending`。
- [ ] 数据库事务只建引用并把状态改为 `active`，`storage_key` 仍指向实际临时文件；提交后同卷移动，再以短事务更新正式键。恢复测试覆盖“已引用未移动”和“已移动未更新键”，并禁止清理任何已有引用的文件。
- [ ] 防路径穿越、扩展名/MIME/文件签名校验、容量保留、完整/单 Range 下载、ETag、鉴权和安全响应头。
- [ ] IIS 应用池对附件无权限，附件目录不配置虚拟目录、静态映射或目录浏览。

## 8. SMTP、Outbox 与后台任务

- [ ] MailKit 固定发件人，拒绝头注入；默认 TLS/STARTTLS 和证书验证，明文例外需显式配置。
- [ ] 业务事务只写 Outbox；`BackgroundService` 使用 SQL 租约领取并在重启后恢复。
- [ ] 邮件包含流程详情链接；`${origin}/flowpilot` 来源经过同源校验并随事件冻结，无请求事件只继承实例验证入口。
- [ ] Outbox 和每次发送尝试保存到 SQL Server；“事件稳定标识 + 激活序号 + 收件人”形成唯一幂等键，不保存完整 MIME、附件或 SMTP 密码。
- [ ] 失败延迟 1/5/15/60/360 分钟，累计 6 次死信；人工重试可审计。
- [ ] 附件清理、会话清理、幂等清理由 `BackgroundService` 执行并使用数据库租约。

## 9. 日志、健康与部署

- [ ] Serilog 输出滚动 JSON 文件到 `{部署根目录}\Logs`，默认 30 天，包含 traceId 且完成秘密/业务值脱敏。
- [ ] `/health/live` 不依赖外部服务；`/health/ready` 验证硬依赖；`/health/details` 需要运维权限且只输出脱敏状态。
- [ ] Windows Service 使用独立低权限账号，程序只读，Config/Secrets 只读，Data/Logs/Temp 按需修改；IIS 账号只读 web。
- [ ] `dotnet publish -c Release -r win-x64` 的实际发布模式（自包含或框架依赖）在目标服务器验证并写入发布记录。
- [ ] `release.json` 记录 releaseId、产品版本、构建时间、提交、API 契约版本、所需数据库结构版本、允许兼容范围、迁移校验和及文件校验信息；发布目录创建后不可覆盖。
- [ ] 计划停机中通过临时联接校验后统一切换 `current`，保留 `previous`；首次安装不创建无效 `previous`，历史版本至少保留当前和上一个完整版本；清理不得跟随目录联接、不得删除 current/previous 的目标或任何外置持久化目录。
- [ ] IIS `/flowpilot` SPA、`/api/flowpilot/*` 反代、入口缓存、Cookie、Range、上传大小、未知 Host、服务重启和回滚全部验收。

## 10. 测试与交付门禁

- [ ] xUnit 单元测试覆盖领域不变量、权限、登录分流、密码、路径、Outbox 与投影。
- [ ] Mapperly 关键映射测试覆盖新增成员、敏感字段忽略、枚举、nullability、集合以及 Entity/Domain/DTO 往返边界；Release build 不得存在 Mapperly warning。
- [ ] `WebApplicationFactory` 覆盖 Controller、Middleware、Problem Details、Cookie、Origin、ETag、幂等和 OpenAPI 语义契约。
- [ ] SQL Server 集成测试覆盖空库/上一版脚本、事务回滚、编号竞争、发布竞争、任务双提交、锁和投影重建。
- [ ] LDAP 与 SMTP 使用可控替身覆盖超时、证书与失败；部署环境再完成一次真实域登录和测试邮件。
- [ ] 附件测试覆盖中断、危险签名、路径穿越、同卷移动、206/416/507、清理和服务重启。
- [ ] 前端 `pnpm typecheck`、受影响 Vitest、Playwright remote 模式与后端 `dotnet test` 均通过。

## 11. 后端开工前仍需由部署人员准备（无需现在填写）

- 实际部署根目录、Windows 服务账号和 IIS 应用池账号。
- SQL Server 主机/端口、数据库名、运行账号、迁移账号、排序规则和证书信任。
- LDAP/LDAPS 地址、Base DN、UPN 后缀、证书，以及必要时的只读搜索账号。
- SMTP 地址/端口/TLS、账号、固定发件人和测试收件人。
- IIS 内外网绑定、端口，以及首次超级管理员密码。

这些值只进入服务器外置 JSON 或部署系统，不写入需求、源代码、Git、截图、测试快照或日志。
