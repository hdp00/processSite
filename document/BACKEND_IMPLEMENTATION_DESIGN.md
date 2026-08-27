# FlowPilot 正式后端实现设计决策

> 状态：已确认，作为后端实现基线
> 最后更新：2026-08-26
> 适用范围：.NET 10 / ASP.NET Core 10、Microsoft SQL Server 2016 SP2 及之后版本、本地附件目录、Windows Server 2016 与 IIS 内网部署

## 1. 文档定位与迁移状态

本文把 `REQUIREMENTS.md` 和 OpenAPI 契约转换为后端工程边界。业务语义与接口细节仍以 `REQUIREMENTS.md` 和 `flowpilot-rest-api.openapi.yaml` 为准。

仓库现有 `apps/api` 是此前的 NestJS 骨架。目标架构已经切换到 .NET 10，本文件描述的是后续实现目标，不表示旧代码已完成迁移。迁移期间不得在同一正式部署中同时运行两套后端，也不得让两套实现共享写流量。

当前部署的 Windows Server 2016 和 SQL Server 2016 SP2 保持不变。本项目明确接受其生命周期风险，不制定服务器或数据库升级计划；后端同时保持对之后 SQL Server 版本的兼容。仍须执行内网隔离、最小权限、受信 TLS、适用补丁、备份恢复和审计等补偿性控制。

## 2. 总体架构

- API：`net10.0`、ASP.NET Core 10 Web API，使用 Controller，不采用 Minimal API 作为主要业务接口组织方式。
- 运行方式：单 API 实例，以原生 .NET Windows Service 运行，Kestrel 只监听 `127.0.0.1`，IIS/ARR 提供前端静态资源和同源反向代理；不使用 WinSW。
- 数据库：支持 Microsoft SQL Server 2016 SP2 及之后版本；13.x 接受 SP2/SP3，主版本 14 及以上受支持，数据库兼容级别不低于 130。共享实现以 2016 SP2/兼容级别 130 为最低能力基线；不实现 SQLite、数据库 provider 切换或跨数据库迁移。
- ORM：EF Core 10 + `Microsoft.EntityFrameworkCore.SqlServer`，底层驱动 `Microsoft.Data.SqlClient`，配置 `UseCompatibilityLevel(130)`。
- 文件：附件保存在代码目录之外的本地磁盘，数据库只存元数据、状态、引用和相对存储键。
- 认证：自定义用户/角色/权限与不透明数据库会话；LDAP 使用 `System.DirectoryServices.Protocols`；本地密码使用 ASP.NET Core `PasswordHasher<TUser>`。不引入完整 Identity 表结构、JWT 或 Data Protection 密钥文件。
- 邮件：`MailKit`/`MimeKit` + SQL Server Outbox；后台工作由 `BackgroundService` 执行并用数据库租约防重入。
- 日志：Serilog 结构化 JSON 文件日志，按日期和大小滚动。
- 契约：仓库 OpenAPI 3.1 YAML 是唯一对外契约；ASP.NET Core 生成实现侧文档并执行语义比较。

建议的 .NET 结构：

```text
apps/api/
├─ FlowPilot.sln
├─ src/
│  ├─ FlowPilot.Api/              Controller、Middleware、配置、宿主
│  ├─ FlowPilot.Application/      用例、事务命令、仓储接口
│  ├─ FlowPilot.Domain/           领域实体、不变量、值对象
│  ├─ FlowPilot.Infrastructure/   EF Core、SqlClient、LDAP、SMTP、文件
│  └─ FlowPilot.Contracts/        C# 请求/响应 DTO
└─ tests/
   ├─ FlowPilot.UnitTests/
   ├─ FlowPilot.ApiTests/
   └─ FlowPilot.SqlServerTests/
```

项目可以保留在前端 pnpm workspace 同一仓库中，但 .NET 构建、还原、测试与发布使用 `dotnet` 命令，不把 NuGet 包伪装成 pnpm 依赖。

## 3. 依赖基线

直接生产依赖保持最小集合：

- `Microsoft.EntityFrameworkCore.SqlServer`
- `Microsoft.Data.SqlClient`
- `Microsoft.Extensions.Hosting.WindowsServices`
- `Microsoft.AspNetCore.OpenApi`
- `System.DirectoryServices.Protocols`
- `MailKit`（包含 MimeKit）
- `Serilog.AspNetCore`
- `Serilog.Sinks.File`
- `Riok.Mapperly`（编译期源码生成器，私有构建依赖）

设计/测试依赖至少包括 `Microsoft.EntityFrameworkCore.Design`、`Microsoft.AspNetCore.Mvc.Testing`、`Microsoft.NET.Test.Sdk` 和 xUnit。具体版本在创建 .NET 工程时锁定，并在目标 Windows Server 2016 上验证 restore、publish、服务启动、SQL/LDAP/SMTP 连接和重启恢复。

不默认引入 Dapper、AutoMapper、MediatR、FluentValidation、Hangfire、Quartz.NET、Redis、消息队列、额外依赖注入容器或服务器端 OpenAPI 桩生成器。优先使用 .NET/ASP.NET Core 内置 DI、Options、DataAnnotations、`System.Text.Json`、Health Checks、Rate Limiting、`BackgroundService`、`IHttpClientFactory`、`Guid.NewGuid()`、加密和流式文件 API。新增库前必须说明必要性、升级风险、传递依赖和目标服务器验证结果。

Mapperly 选择稳定发布通道，并以 `PrivateAssets="all"`、`ExcludeAssets="runtime"` 引用，使生成器及其抽象不进入服务器运行时依赖。首版不启用需要运行时抽象的 reference handling，也不保留 Mapperly attribute。Mapperly 升级必须重新执行 Release build、检查全部诊断并复核关键生成映射；不采用 `next` 预览版本。

## 4. 流程版本、JSON 与查询

流程定义 V1 有 A/B/C、V2 有 A/E/F 时，不在主业务表中建立 A～F 的永久列。每个发布版本保存一份完整、自包含、不可变的表单/流程 JSON 快照；实例锁定版本 ID，并保存该实例当前表单 JSON。这样旧实例永远按 V1 解释，新实例按 V2 解释。

SQL Server 2016 SP2 没有原生 JSON 类型，JSON 统一保存为 `nvarchar(max)` 并增加 `ISJSON` CHECK。`JSON_VALUE`、`JSON_QUERY` 和 `OPENJSON` 只用于约束、诊断、受控迁移或已评审的小范围处理；核心列表、范围筛选和排序不得动态扫描 JSON，也不得依赖 EF Core 的高版本 JSON 列映射。

需要筛选、排序、列表展示或 Excel 导出的动态标量字段同步写入 `instance_field_values` 类型化投影表。投影至少按定义、稳定字段 ID、值类型和值列建索引。表单 JSON 与投影必须在同一事务写入；系统提供校验和重建 CLI。复杂表格、附件、富文本和对象结构保留在 JSON/专表中，不强行投影为单个标量。

## 5. EF Core、原生 SQL 与事务

持久化实体、领域模型和 API DTO 分离，通过 `Riok.Mapperly` partial mapper 生成结构映射。Mapperly mapper 放在拥有目标 DTO 或持久化类型的外层项目中，领域项目不得引用 Mapperly、EF Core、SqlClient 或 API DTO；应用服务只依赖仓储与 `PersistenceUnitOfWork`。

Mapperly 的使用边界：

- 适用于持久化实体 → 领域读取模型、领域模型 → 响应 DTO，以及经过应用服务确认后的简单值对象转换。
- 不允许把创建、更新或 PATCH 请求 DTO 直接映射覆盖 EF Core 跟踪实体，避免 over-posting、revision 被覆盖或绕过领域不变量。
- 权限判断、审计字段、状态迁移、密码散列、主键、revision、创建/更新时间和当前操作者必须由应用服务或领域行为显式赋值。
- `RequiredMappingStrategy` 保持严格模式，未映射成员诊断在项目 `.editorconfig` 中提升为构建错误；有意忽略的成员必须逐项声明，禁止全局关闭诊断。
- 枚举默认按名称或显式规则映射，不依赖可能不同的整数值；未知枚举和 nullability 必须有测试。
- Mapperly 无法清晰表达的复杂转换使用同一 partial mapper 中的手写方法。不要为了“全自动”把业务规则塞入映射配置。
- EF Core `IQueryable` 投影只有在生成表达式能被 SQL Server provider 完整翻译、SQL 形状和权限过滤均有集成测试时才允许；复杂动态字段投影继续使用明确 LINQ 或参数化 SQL。

- 普通 CRUD、稳定关联和常规分页优先使用 EF Core/LINQ。
- 编号分配、版本发布、任务抢占、复杂动态投影及 `UPDLOCK/HOLDLOCK` 场景允许在基础设施层使用参数化 `SqlCommand`。
- 同一用例只使用一个作用域 `DbContext` 和一笔显式事务。原生命令必须复用 `DbContext.Database.GetDbConnection()` 与当前 `DbTransaction`，不得另开连接或混入另一个上下文。
- 需要时使用 `SERIALIZABLE`、`UPDLOCK/HOLDLOCK`；数据库事务保持短小，事务内不得发送 SMTP、移动正式附件或执行其他外部 I/O。
- 乐观并发统一使用整数 `revision` 并映射 ETag/If-Match，不依赖 SQL Server `rowversion`。

所有领域主键由应用通过 `Guid.NewGuid()` 生成并保存为 `uniqueidentifier`；不依赖 SQL Server IDENTITY 生成领域 ID。这样业务对象能在事务前获得稳定标识，便于聚合、Outbox、附件暂存与跨表原子写入。

### 5.1 统一任务中心与自由协作

任务中心不是“审批节点任务”的同义词。持久化任务必须通过 `task_type` 区分 `approval`、`free-collaboration` 和 `resubmission`，API 列表通过带 discriminator 的联合 DTO 返回三种条目；只有 `approval` 强制包含节点、处理方式和流程权限组。自由协作没有流程节点，只绑定当前受理人；驳回待重新提交任务只绑定实际创建人。审批决定接口收到非审批任务 ID 时返回领域冲突，不能通过伪造虚拟审批节点兼容。

自由协作实例在进行中保存唯一当前受理人，并与唯一待处理自由协作任务保持一致。回复和流转事件保存到专用时间线表；参与人是由发起人、历次受理人和回复作者事务内维护的可重建投影。回复编辑只覆盖原回复的最新正文，同时保存编辑人、编辑时间和一条通过 `related_entry_id` 指向原回复、但不含旧正文的编辑事件，不建立回复正文版本表。创建、回复、编辑、转交、改派、关闭、重开、任务变化、参与人投影、附件引用和实例 `updated_at` 必须在相应领域事务内原子提交。

## 6. 数据库结构演进

应用启动不得执行 `Database.Migrate()`、`EnsureCreated()` 或任何自动结构修改。每次结构变更应同时提供：

1. 可审查的 EF Core migration，作为模型演进依据；
2. DBA 可审核、可记录、可在计划停机窗口执行的 SQL 脚本；
3. 空库和上一正式结构版本的测试；
4. 结构版本与校验和更新，以及失败后的前向修复说明。

生产首选 DBA 执行已审查 SQL。EF migration bundle 只能作为受控部署选项，不由常驻应用账号或 Windows 服务启动流程调用。迁移账号与运行账号分离；服务启动只验证数据库版本、兼容级别 130、排序规则、schema 和结构版本，落后时 `/health/ready` 返回 503。

未部署的 Development 环境使用显式 `FlowPilot.DatabaseTool` 执行同一份版本化 SQL。工具只接受已经创建的专用数据库，不执行 `CREATE/DROP DATABASE`，拒绝系统数据库，并在服务器版本、兼容级别和排序规则预检后使用事务级 `sp_getapplock` 原子执行迁移与账本写入。提交前及返回 Current 前按版本化清单核对全部表、列、具名约束、显式索引、触发器和额外对象。API、Windows 服务和测试宿主都不得隐式调用该工具。相同 ID/校验和的成功迁移重复执行为 no-op；部分结构、未知迁移、非成功账本和校验和漂移均失败关闭。

SQL Server 连接字符串必须显式给出加密、证书信任、连接建立超时和连接池上下限，避免 Microsoft.Data.SqlClient 升级改变默认行为。远程连接默认使用 `Encrypt=true;TrustServerCertificate=false` 并验证证书链与主机名；只有部署记录批准的同机回环例外可以降低要求。常规 EF、就绪元数据/种子、结构探测、迁移预检和迁移 DDL 的命令超时统一从强类型 `FlowPilot:Database` 选项读取，使用有限的安全默认值并允许外置覆盖，禁止用 `0` 配置无限命令等待。连接字符串及证书诊断只能输出脱敏结果。

## 7. 外置配置与目录

部署根目录由部署时确定，不固定盘符或上级路径。可替换程序统一放在 `App` 下：每个不可变发布目录同时包含 `api` 与 `web`，`current` 和 `previous` 是指向完整发布目录的本机 NTFS 目录联接。API 与 Web 必须作为经过验证的兼容组合统一切换，不能分别维护两个 `current`。

```text
{部署根目录}/
├─ flowpilot.root                  部署根标记，不含秘密
├─ App/
│  ├─ current/                     -> releases/{当前 releaseId}
│  ├─ previous/                    -> releases/{上一 releaseId}
│  └─ releases/
│     └─ {releaseId}/              不可变完整发布包
│        ├─ api/
│        │  ├─ FlowPilot.Api.exe
│        │  ├─ FlowPilot.Api.dll
│        │  └─ appsettings.json    稳定、非敏感默认值
│        ├─ web/                   前端静态文件
│        └─ release.json           发布、契约和数据库兼容元数据
├─ Config/
│  └─ appsettings.Production.json  环境非敏感配置/覆盖
├─ Secrets/
│  └─ secrets.Production.json      SQL、LDAP、SMTP 凭据和初始密码
├─ Data/Attachments/{yyyy}/        正式附件
├─ Logs/
├─ Temp/
└─ Backup/
```

外置文件位置固定为 `{部署根目录}\Config\appsettings.Production.json` 与 `{部署根目录}\Secrets\secrets.Production.json`。配置值优先级为标准 .NET 进程环境变量 > Secrets JSON > Config JSON > 当前发布包 `api\appsettings.json`，但环境变量不得改变目录或文件位置。`FLOWPILOT_HOME`、`FLOWPILOT_CONFIG_FILE` 和 `FLOWPILOT_SECRETS_FILE` 不再支持；Windows 服务工作目录不得参与路径推导。

本地 Development 不要求模拟生产发布目录。API、数据库工具和 SQL Server 集成测试共同读取仓库内被忽略的 `apps/api/config/appsettings.Development.local.json`；仓库只提供 `.example.json`。数据库工具只从 `AppContext.BaseDirectory` 所在的预期 `tools/FlowPilot.DatabaseTool` 工程布局向上定位该固定路径，不读取当前工作目录且不接受任意配置文件路径覆盖；优先级为默认配置 < 本地 JSON < 环境变量 < 命令行配置值，文件只在进程启动时加载。该本地文件绝不进入生产发布包，生产环境也不读取它。

路径解析封装为可注入接口。生产实现从 `AppContext.BaseDirectory` 开始，包含当前目录在内最多检查 6 层祖先目录，必须且只能找到一个名为 `flowpilot.root` 的部署根标记；这样无论运行时保留 `current` 路径还是解析为实际 `releases\{releaseId}` 路径，都能得到同一部署根。禁止退回固定取父目录、Windows Service 当前工作目录或环境变量。测试实现使用独立临时目录。启动时还必须验证部署根不是磁盘根、当前 API 位于该根的 `App` 边界内、联接目标位于本机 `App\releases` 内、Config/Secrets 文件存在，并规范化和验证所有最终绝对路径。

真实 Config/Secrets 文件不提交 Git、不进入发布包或 IIS 目录。首版不使用 `.env` 解析器、DPAPI、外部秘密平台或 Data Protection 密钥文件。Secrets 是明文 JSON，只允许服务账号读取、部署管理员修改；日志和健康接口不得输出连接字符串或完整配置。

## 8. 附件状态机

上传采用流式 `multipart/form-data` 写入 `{部署根目录}\Data\Attachments\{yyyy}\.incoming\{attachmentIdN}.part`，同时计算大小和 SHA-256，不把整文件加载到托管内存。先创建 `uploading` 元数据；完整写入并校验后进入 `staged`。业务命令在数据库事务内建立引用并将状态改为 `active`，但 `storage_key` 继续指向当前实际存在的 `.incoming` 文件。事务提交后 worker 再执行同卷原子移动，移动成功后用短事务把 `storage_key` 改为正式对象键；在此之前下载仍按当前键读取。移动或键更新中断时，恢复逻辑必须同时检查临时键和目标键并用大小/SHA-256 核对，不能把已有业务引用的附件当成普通暂存文件清理。可恢复移动错误保留 `active` 和 `last_error` 并重试，`failed` 只用于未建立业务引用的上传/校验失败。根目录 `Temp` 只用于非附件临时工作，不进入附件状态机。

附件 GUID 统一格式化为小写 32 位 `attachmentIdN`，分片 `shard` 固定取其前两位；临时相对键为 `{yyyy}/.incoming/{attachmentIdN}.part`，正式相对键为 `{yyyy}/objects/{shard}/{attachmentIdN}`。年份按 `Asia/Shanghai` 的附件创建时间固化，所以 2026 年附件均位于 `Data\Attachments\2026`；分片算法由单一存储服务实现并保持向后兼容。数据库不保存绝对路径，任何用户文件名和扩展名不得参与物理路径拼接。删除采用先标记 `cleanup-pending`、后清理；替换新附件成功前不删除旧附件。内部完整状态为 `uploading | staged | active | cleanup-pending | failed | deleted`，普通业务 API 只暴露 `staged | active | cleanup-pending`。

启动和就绪检查必须验证根目录为绝对路径、位于程序/IIS 静态目录之外、临时与正式目录同卷、服务账号权限和磁盘保留空间。IIS 应用池不得访问或静态映射附件目录。下载只能经过鉴权 API，并支持完整响应、单 Range、ETag、Content-Disposition 与安全 MIME。

## 9. 认证、会话和请求安全

- LDAP 使用 `System.DirectoryServices.Protocols`，参数化/转义搜索值。用户 UPN bind 后，在 Base DN 内确认同一规范化 `sAMAccountName` 与 `userPrincipalName` 的唯一结果。域密码仅存在于本次调用内。
- 默认 LDAPS 并验证证书；旧 `ldap://` 仅通过独立配置显式接受。域故障不得回退本地密码。
- `authentication_mode=password` 用户只调用 `PasswordHasher<TUser>`；无论成功、失败或停用都不得探测 LDAP。`SuccessRehashNeeded` 时在成功登录事务中更新散列。
- 使用自定义 `users`/角色/权限表和不透明会话表，不采用完整 Identity schema。Cookie 只保存高强度随机令牌，数据库只保存令牌散列；闲置 8 小时、绝对 24 小时。
- `flowpilot_session` 设置 `Path=/api/flowpilot`、`HttpOnly`、`SameSite=Strict`；当前 HTTP 部署不设 `Secure`，将来若启用 HTTPS 再由配置开启。
- 登录成功必须通过 `Set-Cookie` 建立 `flowpilot_session`，注销必须使用相同名称和 Path 清除 Cookie。正式 API 关闭 CORS；登录、注销和其他写请求都优先校验 Origin，仅缺失时读取 Referer，与可信 IIS 代理后的 scheme/host 精确匹配，否则返回 403。
- `ForwardedHeadersMiddleware` 只信任 loopback。IIS 丢弃并覆盖外部 `X-Forwarded-For/Host/Proto`，限制站点绑定并拒绝未知 Host。

内置超级管理员仍使用自定义用户表中的 `is_builtin_super_admin` 标记，以数据库约束保证唯一且不可删除/停用/改为域登录。初始密码从 Secrets JSON 读取且只在账号不存在时散列写入，初始化后可从文件删除。

## 10. API 契约与前端边界

正式基础路径固定为 `/api/flowpilot/v1`。OpenAPI YAML 是唯一对外契约；`@redocly/cli` lint，Orval 从它生成前端 TypeScript 类型和 Axios 客户端。后端 C# DTO 与 DataAnnotations/领域校验手工实现，使用 `Microsoft.AspNetCore.OpenApi` 输出实现文档并进行语义契约测试；不使用 NSwag 或服务器桩生成器。

错误返回 Problem Details + 稳定业务码 + traceId。写命令支持 Idempotency-Key；可并发更新资源支持 ETag/If-Match。正式浏览器只用同源 Cookie，Axios 只属于前端；后端外部 HTTP 调用使用 `IHttpClientFactory`。

Excel 继续由浏览器使用 ExcelJS 生成，后端只返回经权限和查询条件过滤的数据集，最多 10000 行。

## 11. Outbox 与后台服务

需要发邮件时只在业务事务中写 Outbox，提交后由 `BackgroundService` 使用 MailKit 发送。后台邮件、附件清理、过期会话和幂等清理均通过 SQL 租约领取，进程重启后能恢复，不能只依赖内存定时器。

任务通知路径为 `/processes/{instanceId}?taskId={taskId}`，结束通知为 `/processes/{instanceId}`。浏览器写请求通过同源校验后，把 `${origin}/flowpilot` 随 Outbox 冻结；无请求事件只能继承实例此前验证入口，缺失时明确失败，不能猜测 loopback、服务器名或 Host。首次解析的绝对链接持久化，重试不得改变。

Outbox 与每次发送尝试都保存到 SQL Server，包括事件、实例/任务、收件人与邮箱快照、主题、最小模板数据、链接、状态、时间、次数和脱敏错误；不保存完整 MIME、业务附件或 SMTP 凭据。失败按 1、5、15、60、360 分钟重试，累计 6 次进入死信。

## 12. 健康、日志和部署

- `/health/live`：匿名进程存活；不得依赖数据库。
- `/health/ready`：匿名简化就绪；数据库不可用、结构不匹配或附件硬性条件失败返回 503。
- `/health/details`：需要运维权限，显示数据库、LDAP、SMTP、磁盘和后台任务的脱敏状态。
- Serilog 输出 UTC、level、traceId、事件名和脱敏上下文的 JSON 文件，默认保留 30 天；不得记录密码、令牌、完整表单、附件正文或秘密。
- 发布只新增不可变的 `App\releases\{releaseId}`，并在计划停机中统一切换 `App\current`；不得直接覆盖当前发布目录，也不触碰 Config、Secrets、Data、Logs、Temp、Backup。`release.json` 至少记录 releaseId、产品版本、构建时间、源代码提交、API 契约版本、所需数据库结构版本、允许兼容的结构版本范围、迁移校验和及文件校验信息。切换前校验发布清单与数据库结构，切换后执行健康检查和前后端回归；失败时仅在数据库仍兼容的前提下将 `current` 指回 `previous`。首次安装没有 `previous` 时不得创建无效联接；历史发布默认至少保留当前和上一个完整版本，清理只能删除未被任何联接引用且已通过清单校验的更旧目录。

## 13. 测试与验收

- 后端单元测试使用 xUnit；HTTP/契约测试使用 `WebApplicationFactory`。
- Mapperly 构建诊断必须为零；关键 Entity/Domain/DTO 双向映射、枚举、null、忽略敏感字段和新增成员漂移均有单元测试。
- 数据库集成测试必须覆盖真实 SQL Server 2016 SP2、兼容级别 130 最低基线，并复验实际部署使用的较新 SQL Server 版本/兼容级别；不得用 EF InMemory 或 SQLite 替代，也不得只测较新版本而跳过最低基线。
- 验证 EF Core CRUD 与共享事务原生 SQL、迁移脚本、锁、并发、JSON 约束和投影重建。
- 验证 LDAP/SMTP 超时和证书、Cookie、Origin/Referer、限流、转发头、Outbox 恢复、附件中断/Range/507 和服务重启。
- V1 A/B/C 与 V2 A/E/F 实例必须共存，详情按锁定版本展示，查询读取投影而非扫描 JSON。

## 14. 首版明确不做

- 服务器或 SQL Server 升级计划；
- SQLite、多数据库 provider 或数据库热切换；
- 多 API 实例、高可用、零停机发布；
- JWT、API Key、完整 Identity schema、Windows 集成认证；
- Redis、消息队列、Hangfire、Quartz.NET；
- 附件分片、断点续传、去重、病毒扫描状态机或对象存储；
- 应用内自动定时备份、实例删除或自动归档；
- 依赖动态 JSON 扫描实现核心查询。

## 15. 技术依据

- [.NET 与 .NET Core 官方支持策略](https://dotnet.microsoft.com/en-us/platform/support/policy)
- [.NET 在 Windows 上的支持范围](https://learn.microsoft.com/en-us/dotnet/core/install/windows)
- [ASP.NET Core 10 OpenAPI](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/openapi/aspnetcore-openapi?view=aspnetcore-10.0)
- [ASP.NET Core Windows Service 托管](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/windows-service?view=aspnetcore-10.0)
- [EF Core SQL Server provider](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [EF Core migration 的生产应用方式](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying)
- [Mapperly 官方安装说明](https://mapperly.riok.app/docs/getting-started/installation/)
- [Mapperly mapper 配置与严格映射](https://mapperly.riok.app/docs/configuration/mapper/)
- [Windows Server 2016 生命周期](https://learn.microsoft.com/en-us/lifecycle/products/windows-server-2016)
- [SQL Server 2016 生命周期](https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2016)

以上链接用于说明框架能力和已接受的生命周期事实，不改变“本项目不制定 Windows Server/SQL Server 升级计划”的决定。
