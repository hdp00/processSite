# FlowPilot 正式后端实现设计决策

> 状态：已确认，作为后端实现基线
> 最后更新：2026-08-31
> 适用范围：.NET 10 / ASP.NET Core 10、Microsoft SQL Server 2016 SP2 及之后版本、本地附件目录、Windows Server 2016 与 IIS 内网部署

## 1. 文档定位与迁移状态

本文把 `REQUIREMENTS.md` 和 OpenAPI 契约转换为后端工程边界。业务语义与接口细节仍以 `REQUIREMENTS.md` 和 `flowpilot-rest-api.openapi.yaml` 为准。

旧 NestJS 骨架已删除。当前 `apps/api` 已完成 OpenAPI 中的首版 REST 端点，包括认证与域登录、组织权限、流程定义全生命周期及导入导出、任务和流程实例、自由协作、附件、邮件 Outbox、审计、Excel 数据集与运维状态。数据库初始化、开发配置、后台邮件发送及数据清理也已接通；实际 LDAP、SMTP、IIS 和 Windows Service 仍需使用部署环境值完成联调验收。

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
├─ FlowPilot.slnx
├─ src/
│  ├─ FlowPilot.Api/              Controller、Middleware、配置、宿主
│  ├─ FlowPilot.Application/      纵向用例服务、权限与业务编排
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

设计/测试依赖至少包括 `Microsoft.EntityFrameworkCore.Design`、`Microsoft.AspNetCore.Mvc.Testing`、`Microsoft.NET.Test.Sdk` 和 xUnit。具体版本在创建 .NET 工程时锁定，并在目标 Windows Server 2016 上验证 restore、publish、服务启动、SQL/LDAP/SMTP 连接和重启恢复。

不默认引入 Dapper、AutoMapper、MediatR、FluentValidation、Hangfire、Quartz.NET、Redis、消息队列、额外依赖注入容器或服务器端 OpenAPI 桩生成器。优先使用 .NET/ASP.NET Core 内置 DI、Options、DataAnnotations、`System.Text.Json`、Health Checks、Rate Limiting、`BackgroundService`、`IHttpClientFactory`、`Guid.NewGuid()`、加密和流式文件 API。有明确简化价值、能降低协议或安全实现风险且维护状态合适的第三方库可以直接采用，并向项目负责人通知用途和锁定版本；不为简单字段搬运或少量工具逻辑引入大型框架。

首版不强制引入 Mapperly、AutoMapper 或其他对象映射框架。简单 DTO 投影优先直接写在 LINQ `Select` 中，写模型转换使用短小的显式赋值或同一纵向切片内的普通静态方法；只有重复映射已经形成明确维护成本时，才评估新增映射工具。

## 4. 流程版本、JSON 与查询

流程定义 V1 有 A/B/C、V2 有 A/E/F 时，不在主业务表中建立 A～F 的永久列。每个发布版本保存一份完整、自包含、不可变的表单/流程 JSON 快照；实例锁定版本 ID，并保存该实例当前表单 JSON。这样旧实例永远按 V1 解释，新实例按 V2 解释。

SQL Server 2016 SP2 没有原生 JSON 类型，JSON 统一保存为 `nvarchar(max)` 并增加 `ISJSON` CHECK。`JSON_VALUE`、`JSON_QUERY` 和 `OPENJSON` 只用于约束、诊断、受控迁移或已评审的小范围处理；核心列表、范围筛选和排序不得动态扫描 JSON，也不得依赖 EF Core 的高版本 JSON 列映射。

需要筛选、排序、列表展示或 Excel 导出的动态标量字段同步写入 `instance_field_values` 类型化投影表。投影至少按定义、稳定字段 ID、值类型和值列建索引。表单 JSON 与投影必须在同一事务写入；系统提供校验和重建 CLI。复杂表格、附件、富文本和对象结构保留在 JSON/专表中，不强行投影为单个标量。

## 5. EF Core、原生 SQL 与事务

首版按业务能力建立小而完整的纵向切片，默认调用链为 `Controller → Application Service → FlowPilotDbContext`。Controller 负责 HTTP 契约、身份上下文和响应映射；Application Service 负责权限、输入、状态、并发与事务边界，并可直接使用作用域 `DbContext`。不强制为每个实体建立 Repository、Data Mapper 或统一 Unit of Work；只有出现跨切片重复且边界稳定的查询或外部能力时才提取小型接口。

- 读取使用 EF Core/LINQ，并优先直接 `Select` 为响应 DTO，避免先加载完整实体图再机械映射。
- 创建、更新或 PATCH 不得把请求 DTO 整体覆盖到 EF Core 跟踪实体；主键、revision、审计字段、权限相关字段和状态迁移必须在服务中校验后显式赋值。
- 普通 CRUD、稳定关联和常规分页优先使用 EF Core/LINQ。只有编号分配、版本发布、任务抢占、复杂动态投影及 `UPDLOCK/HOLDLOCK` 等 EF Core 难以清晰表达的场景才使用少量参数化 `SqlCommand`。
- 单次请求默认复用一个作用域 `DbContext`；只有跨多次保存或必须锁定的用例才开启显式事务。原生命令必须复用 `DbContext.Database.GetDbConnection()` 与当前 `DbTransaction`，不得另开连接或混入另一个上下文。
- 需要时使用 `SERIALIZABLE`、`UPDLOCK/HOLDLOCK`；数据库事务保持短小，事务内不得发送 SMTP、移动正式附件或执行其他外部 I/O。
- 乐观并发统一使用整数 `revision` 并映射 ETag/If-Match，不依赖 SQL Server `rowversion`。

所有领域主键由应用通过 `Guid.NewGuid()` 生成并保存为 `uniqueidentifier`；不依赖 SQL Server IDENTITY 生成领域 ID。这样业务对象能在事务前获得稳定标识，便于聚合、Outbox、附件暂存与跨表原子写入。

### 5.1 统一任务中心与自由协作

任务中心不是“审批节点任务”的同义词。持久化任务必须通过 `task_type` 区分 `approval`、`free-collaboration` 和 `resubmission`。列表按流程实例分页，每项同时返回实例摘要和该实例在当前视图下的任务数组，避免并行节点重复流程行或跨页丢失；同一响应额外按流程汇总忽略 `definitionId` 后的完整数量，供左侧流程分类使用，不能用当前页数据估算。数组中的任务 DTO 使用 `taskType` discriminator，只有 `approval` 强制包含节点、处理方式和流程权限组。自由协作没有流程节点，只绑定当前受理人；驳回待重新提交任务只绑定实际创建人。审批决定接口收到非审批任务 ID 时返回领域冲突，不能通过伪造虚拟审批节点兼容。

审批任务读取和首次结果提交使用任务自身的 ETag。提交时再次检查系统审核权限、节点流程权限组当前有效成员、节点处理方式和字段白名单；EF Core revision 并发条件保证默认责任人与代办人员只有首个提交成功。授权字段、字段修订号、附件引用、实际处理人、后续 AND 汇聚与条件节点、并行取消、驳回策略、实例状态、时间线、审计和幂等结果在同一短事务内保存。该常规状态更新不使用额外手写 SQL。

开启重复修改的已完成审批或确认任务仍使用任务 ETag。只有原实际处理人或超级管理员可以修改当前轮次授权字段；实例进入驳回待处理、关闭或新轮次后立即禁止。命令保留原任务结果和完成时间，只增加 task revision、实例字段修订号、最新表单/附件、查询投影及不可变修改事件。事件只保存字段标识和当时名称，不保存修改前后的业务值。

关闭审批流程使用实例 ETag 和幂等键，并同时校验系统关闭动作权限与实例锁定版本的关闭权限组当前成员资格。“仅允许重新提交”的驳回实例拒绝关闭；其他未关闭状态均可关闭。关闭命令原子更新实例终态、取消全部未激活或待处理任务，并写入含关闭原因的时间线和治理审计。

自由协作实例在进行中保存唯一当前受理人，并与唯一待处理自由协作任务保持一致。回复和流转事件保存到专用时间线表；参与人是由发起人、历次受理人和回复作者事务内维护的可重建投影。回复编辑只覆盖原回复的最新正文，同时保存编辑人、编辑时间和一条通过 `related_entry_id` 指向原回复、但不含旧正文的编辑事件，不建立回复正文版本表。创建、回复、编辑、变更受理人、关闭、重开、任务变化、参与人投影、附件引用、邮件 Outbox 和实例 `updated_at` 必须在相应领域事务内原子提交。

当前已实现文字回复、回复附件、回复编辑与变更受理人：回复不改变受理人；参与人，以及锁定版本发起权限组或审批/受理权限组的当前有效成员均可回复，后两类权限组成员也可变更受理人，均不要求是实际发起人或当前受理人。该操作完成原待办并创建新受理人的唯一待办，也可在同一请求内先发表回复；不再设置独立的异常改派接口。新增回复和变更受理人使用实例 ETag 与幂等键，回复编辑按契约只使用实例 ETag；服务端原子更新参与人、时间线、审计与实例版本。编辑只保留最新正文，另存不含旧正文的编辑事件。回复附件使用 `purpose=free-reply` 和实例范围暂存，每条回复最多20个；回复事务重新校验上传人、用途、暂存状态和未引用状态，再原子保存正文、附件引用与时间线。

自由协作关闭使用实例 ETag 和幂等键，同时校验“任务中心-关闭”动作权限与锁定版本关闭权限组当前成员资格。成功后在同一事务中取消唯一当前待办、清空当前受理人和当前节点摘要、写入关闭原因时间线及审计，并更新实例关闭时间和最后更新时间。发起人、当前受理人或历史参与人身份不自动获得关闭资格。

自由协作重新打开使用实例 ETag 和幂等键，只允许锁定版本发起权限组当前成员、历史参与人或超级管理员处理已关闭事项。服务端重新校验新受理人属于锁定版本审批/受理权限组，并在同一事务中恢复进行中状态、清除当前关闭标记、创建唯一当前待办、增加新受理人的参与人投影、写入原因时间线和审计。仅执行重新打开的发起组成员不会自动成为参与人。

自由协作初始表单修改按实例 ETag 执行，只允许实际发起人或超级管理员处理进行中事项。命令复用流程实例统一表单、附件与字段投影逻辑，原子更新最新表单、标题、附件引用、字段修订号、列表查询投影、字段名称时间线、审计和实例更新时间，不改变当前受理人或待办。无变化保存不写入任何业务更新，留痕不保存字段修改前后的值。

## 6. 数据库结构演进

应用启动不得执行 `Database.Migrate()`、`EnsureCreated()` 或任何自动结构修改。每次结构变更应同时提供：

1. 可审查的 EF Core migration，作为模型演进依据；
2. DBA 可审核、可记录、可在计划停机窗口执行的 SQL 脚本；
3. 空库和上一正式结构版本的测试；
4. 结构版本与校验和更新，以及失败后的前向修复说明。

生产首选 DBA 执行已审查 SQL。EF migration bundle 只能作为受控部署选项，不由常驻应用账号或 Windows 服务启动流程调用。迁移账号与运行账号分离；服务启动只验证数据库版本、兼容级别 130、排序规则、schema 和结构版本，落后时 `/health/ready` 返回 503。

未部署的 Development 环境使用显式 `FlowPilot.DatabaseTool` 执行同一份版本化 SQL。工具只接受已经创建的专用数据库，不执行 `CREATE/DROP DATABASE`，拒绝系统数据库，并在服务器版本、兼容级别和排序规则预检后使用事务级 `sp_getapplock` 原子执行迁移与账本写入。迁移账本保留迁移 ID、版本、结果和 SQL 脚本 SHA-256 校验和；提交前及返回 Current 前只按版本化清单精确核对表、列、具名约束、显式索引和触发器名称，缺失或多出的名称都失败。结构验证不解析或比较 SQL 定义指纹、列/约束/索引完整签名，也不扫描视图、存储过程等其他对象类型。API、Windows 服务和测试宿主都不得隐式调用该工具。相同 ID/校验和的成功迁移重复执行为 no-op；部分清单结构、未知迁移、非成功账本和校验和漂移均失败关闭。

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

数据库结构版本与内置数据版本是程序兼容边界，由后端代码分别统一定义，不能通过配置文件或环境变量覆盖。数据库迁移、Seed、验证工具和就绪检查必须引用同一代码常量；配置仅保存连接字符串、预期排序规则、超时及其他随环境变化的值。

路径解析封装为可注入接口。生产实现从 `AppContext.BaseDirectory` 开始，包含当前目录在内最多检查 6 层祖先目录，必须且只能找到一个名为 `flowpilot.root` 的部署根标记；这样无论运行时保留 `current` 路径还是解析为实际 `releases\{releaseId}` 路径，都能得到同一部署根。禁止退回固定取父目录、Windows Service 当前工作目录或环境变量。测试实现使用独立临时目录。启动时还必须验证部署根不是磁盘根、当前 API 位于该根的 `App` 边界内、联接目标位于本机 `App\releases` 内、Config/Secrets 文件存在，并规范化和验证所有最终绝对路径。

真实 Config/Secrets 文件不提交 Git、不进入发布包或 IIS 目录。首版不使用 `.env` 解析器、DPAPI、外部秘密平台或 Data Protection 密钥文件。Secrets 是明文 JSON，只允许服务账号读取、部署管理员修改；日志和健康接口不得输出连接字符串或完整配置。

## 8. 附件状态机

上传采用流式 `multipart/form-data` 写入 `{部署根目录}\Data\Attachments\{yyyy}\.incoming\{attachmentIdN}.part`，同时计算大小和 SHA-256，不把整文件加载到托管内存。先创建 `uploading` 元数据；完整写入并校验后进入 `staged`。业务命令在数据库事务内建立引用并将状态改为 `active`，但 `storage_key` 继续指向当前实际存在的 `.incoming` 文件。事务提交后 worker 再执行同卷原子移动，移动成功后用短事务把 `storage_key` 改为正式对象键；在此之前下载仍按当前键读取。移动或键更新中断时，恢复逻辑必须同时检查临时键和目标键并用大小/SHA-256 核对，不能把已有业务引用的附件当成普通暂存文件清理。可恢复移动错误保留 `active` 和 `last_error` 并重试，`failed` 只用于未建立业务引用的上传/校验失败。根目录 `Temp` 只用于非附件临时工作，不进入附件状态机。

富文本图片和视频使用同一上传接口并指定 `purpose=rich-text-media`，不附带流程或字段范围。服务端根据文件签名确认 `image/*` 或 `video/*` 后直接转为受认证的 `active` 媒体附件；HTML 只保存 `data-attachment-id` 和同源 `/api/flowpilot/v1/attachments/{id}/content?disposition=inline` 地址，前端净化时删除 Base64、Blob URL、外部地址和无效标识。该内部站点的富文本媒体使用不可预测 UUID 并要求登录后读取；当前不建立正文级引用表，媒体按长期资产保留，且不能通过暂存附件删除接口删除，避免浏览器刷新、换设备、暂存清理或上传人误删导致正文失效。若以后需要按正文删除孤儿媒体或把媒体权限进一步缩小到单个实例，应新增服务端引用表和清理任务，而不能退回浏览器存储。

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

流程定义创建、基本信息和流程图保存需要 `config-definition:编辑`，表单保存需要 `config-form:编辑`，重新校验、发布、切换和取消发布需要 `config-definition:发布`。创建、重新校验和发布生命周期命令使用 Idempotency-Key；版本保存与重新校验使用版本 If-Match，发布使用目标版本 If-Match，取消发布使用流程定义 If-Match。

流程发起中心需要 `work-launch:查看`，读取具体发起配置和后续实例创建需要 `work-launch:发起`。普通用户还必须属于发布版本任一发起权限组的当前有效成员；超级管理员可以越权发起，但不加入权限组，也不出现在审批人或自由协作受理人候选中。

实例创建采用单个可串行化事务：以当前发布指针锁定版本，重新检查流程依赖与发起资格，分配共享月度流水号，保存表单 JSON 和查询投影，创建固定审批任务或自由协作首位受理任务，并同步实例计数、时间线、参与人、附件引用、审计和幂等响应。普通写入使用 EF Core；只有幂等键与编号计数器的行锁使用短小、固定的 SQL Server 锁提示。

审批实例在首个审核结果产生前允许实际创建人或超级管理员按实例 ETag 保存发起内容。该命令继续按实例锁定版本校验完整表单、附件字段和默认责任人，并在一个 EF Core 可串行化事务中更新表单 JSON、字段修订号、查询投影、条件节点状态、未完成任务、附件引用、时间线和审计；本轮一旦存在通过、确认或驳回结果即返回 `INSTANCE_CONTENT_LOCKED`。

驳回待处理实例的重新提交使用 ETag 和 Idempotency-Key。只有实际创建人或超级管理员可以执行；命令完成当前待重新提交任务，保留旧轮次审核任务和默认责任人，使用实例锁定版本生成完整下一轮任务，并与表单、附件、字段修订号、查询投影、时间线和审计原子提交。重新提交不接受默认责任人修改，流程定义后续发布、取消发布或停用不影响该操作。

实例详情使用实例锁定版本返回表单、节点任务、审批进度、流程/自由协作时间线和附件。页面权限与实例数据范围分开判断；发起人、参与人、任务默认或实际处理人、锁定版本权限组当前有效成员及额外可见角色/用户可读取相关实例，具有实例监控查看权限的用户可读取全部实例。

Excel 继续由浏览器使用 ExcelJS 生成。后端通过 EF Core 将实例数据范围、系统字段和动态标量字段的筛选及排序转换为 SQL，并只查询当前发布版本的导出字段；先读取 10001 个实例标识探测上限，超过时拒绝导出，确认不超过 10000 行后才加载生成文件所需的数据。历史版本缺少当前字段时输出空值，不扫描表单 JSON 完成核心查询。

## 11. Outbox 与后台服务

审批任务激活、流程完成、自由协作受理任务创建或自由协作关闭时，由业务命令在保存流程状态的同一事务中写入 Outbox；自由协作每次创建新受理待办时只通知该次操作后当前选中的最新受理人，不通知历史受理人，关闭时通知发起人，且不依赖节点邮件开关。提交后 `BackgroundService` 只领取已有消息并使用 MailKit 发送，不再扫描流程状态补建消息。后台邮件、附件清理、过期会话和幂等清理均通过 SQL 租约领取，进程重启后能恢复，不能只依赖内存定时器。

任务通知路径为 `/processes/{instanceId}?taskId={taskId}`，结束通知为 `/processes/{instanceId}`。浏览器写请求通过同源校验后，把 `${origin}/flowpilot` 随 Outbox 冻结；无请求事件只能继承实例此前验证入口，缺失时明确失败，不能猜测 loopback、服务器名或 Host。首次解析的绝对链接持久化，重试不得改变。

Outbox 与每次发送尝试都保存到 SQL Server，包括事件、实例/任务、收件人与邮箱快照、主题、最小模板数据、链接、状态、时间、次数和脱敏错误；不保存完整 MIME、业务附件或 SMTP 凭据。`FlowPilot:Smtp:TestEMail` 非空有效时，实际邮箱为空的预定收件人也生成 Outbox，所有新建和待处理通知统一投递到该测试邮箱；配置无效时不得回退到真实邮箱。失败按 1、5、15、60、360 分钟重试，累计 6 次进入死信。

通知开关、收件人用户、有效邮箱、主题和最小模板数据在业务事件发生时冻结。之后的用户邮箱、权限组成员或流程配置变化只影响新事件，不改写现有 Outbox，也不为历史流程补建邮件。当前数据库没有需要保留的真实业务数据，因此不增加旧消息或旧实例的迁移回填代码。

## 12. 健康、日志和部署

- `/health/live`：匿名进程存活；不得依赖数据库。
- `/api/flowpilot/v1/health/ready`：匿名简化就绪；数据库不可用、结构不匹配或附件硬性条件失败返回 503。
- `/health/details`：需要运维权限，显示数据库、LDAP、SMTP、磁盘和后台任务的脱敏状态。
- Serilog 输出 UTC、level、traceId、事件名和脱敏上下文的 JSON 文件，默认保留 30 天；不得记录密码、令牌、完整表单、附件正文或秘密。
- 发布只新增不可变的 `App\releases\{releaseId}`，并在计划停机中统一切换 `App\current`；不得直接覆盖当前发布目录，也不触碰 Config、Secrets、Data、Logs、Temp、Backup。`release.json` 至少记录 releaseId、产品版本、构建时间、源代码提交、API 契约版本、所需数据库结构版本、允许兼容的结构版本范围、迁移校验和及文件校验信息。切换前校验发布清单与数据库结构，切换后执行健康检查和前后端回归；失败时仅在数据库仍兼容的前提下将 `current` 指回 `previous`。首次安装没有 `previous` 时不得创建无效联接；历史发布默认至少保留当前和上一个完整版本，清理只能删除未被任何联接引用且已通过清单校验的更旧目录。

## 13. 测试与验收

- 后端单元测试使用 xUnit；HTTP/契约测试使用 `WebApplicationFactory`。
- 关键读取投影和写入字段白名单必须有单元或 API 测试，覆盖枚举、null、敏感字段忽略、over-posting、权限与 revision 并发边界。
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
- [Windows Server 2016 生命周期](https://learn.microsoft.com/en-us/lifecycle/products/windows-server-2016)
- [SQL Server 2016 生命周期](https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2016)

以上链接用于说明框架能力和已接受的生命周期事实，不改变“本项目不制定 Windows Server/SQL Server 升级计划”的决定。

## 16. 变更记录

| 日期 | 变更内容 |
| --- | --- |
| 2026-08-31 | 自由协作首次受理、变更受理人和重新打开均在任务事务内只向当前最新受理人创建邮件 Outbox，不通知历史受理人；事项关闭在关闭事务内向发起人创建邮件 Outbox。 |
| 2026-08-31 | 收口代码审查 CR-006、CR-007：Outbox 改为业务事务内原子创建，发送器仅负责投递；流程清单导出改为 SQL 端权限、筛选、排序和行数上限探测，并按当前发布版本输出字段。 |
| 2026-08-28 | 完成首版 REST 契约收口：流程定义生命周期与导入导出、权限组变更影响、邮件 Outbox、审计、流程清单 Excel 数据集和详细运维状态均已落地；接入 LDAPS、MailKit SMTP 及后台附件、会话、幂等和邮件清理。 |
| 2026-08-28 | 第三方库改为“有明确价值即可采用并通知”，不再要求事前确认；继续保持小型内部系统所需的简洁边界。 |
| 2026-08-28 | 完成服务端模拟身份：真实超级管理员可分页查询启用的非内置用户，在当前会话开始或结束模拟；权限按目标用户计算，会话精确关联模拟记录，切换与退出均记录真实操作者、生效用户和审计。 |
| 2026-08-28 | 确认自由协作新增回复支持附件；附件先暂存，再与回复正文、引用和时间线原子提交，展示与下载沿用实例数据范围和统一附件权限。 |
| 2026-08-28 | 完成自由协作初始表单修改；复用统一表单、附件和投影逻辑，保留受理人与待办，并记录不含前后值的字段名称时间线。 |
| 2026-08-28 | 合并自由协作异常改派与变更受理人；发起或受理权限组成员统一通过变更接口指定新受理人并记录时间线。 |
| 2026-08-28 | 完成自由协作关闭；校验关闭动作和关闭权限组，原子取消当前待办、清空受理人并记录原因、时间线与审计。 |
| 2026-08-28 | 完成自由协作重新打开；发起组成员或历史参与人可指定有效受理人，原子恢复进行中状态、创建唯一待办并记录时间线与审计。 |
| 2026-08-28 | 完成自由协作回复编辑；仅原作者可在进行中按实例 ETag 覆盖正文，记录编辑元数据和不含旧正文的编辑事件，并拒绝无变化保存。 |
| 2026-08-28 | 完成自由协作文字回复与转交；支持回复并变更受理人的原子提交，同步维护当前受理人、唯一待办、参与人、时间线、审计和实例 ETag。 |
| 2026-08-28 | 完成审批结果后的重复字段修改；按任务 ETag、原实际处理人、当前轮次和字段白名单校验，原审核结果保持不变，并只记录字段标识与名称。 |
| 2026-08-28 | 完成单个任务读取和审批任务首次结果提交；支持通过、确认、驳回、字段/附件原子修改、动态代办资格、后续条件节点推进、并行取消、驳回待重新提交或自动关闭。 |
| 2026-08-28 | 完成驳回后重新提交：幂等完成待重新提交任务，保留旧轮次并按实例锁定版本生成完整新审核轮次。 |
| 2026-08-28 | 完成审批实例首个审核结果前的发起内容保存，表单、查询投影、条件任务、默认责任人、附件替换、时间线和审计在同一事务更新。 |
| 2026-08-28 | 部门和职务的普通查询与增删改改用 EF Core/LINQ；幂等键锁定和审计写入继续使用集中管理的参数化 SQL，并复用同一个 `DbContext` 连接和事务。 |
| 2026-08-27 | 完成部门、职务、用户和角色目录读取，用户/角色创建，以及流程权限组增删改查和有效成员查询；相关接口使用既有分页、权限、ETag、幂等和审计约定。 |
| 2026-08-27 | 完成角色详情、编辑、启停、删除与变更影响预览；角色删除检查用户、流程权限组和全部流程版本引用，前端在资格或待办受影响时要求再次确认。 |
| 2026-08-27 | 完成部门与职务详情、新增、编辑、启停和删除；部门维护两级路径和同级名称唯一，部门/职务删除执行用户与下级部门引用保护。 |
| 2026-08-27 | 补充流程定义创建、V1 分区保存与重新校验切片状态，并明确对应权限、幂等和并发契约。 |
| 2026-08-27 | 按小型内部系统“简洁优先”调整实现基线：纵向切片默认采用 Controller → Application Service → EF Core，取消强制 Data Mapper、Mapperly、逐实体 Repository 和统一 Unit of Work；保留显式字段白名单、权限/状态/并发校验与必要事务。数据库继续校验迁移账本、版本、结果和脚本 SHA-256 校验和，结构清单仅精确比较表、列、具名约束、显式索引和触发器名称，不再校验 SQL 定义指纹、完整结构签名或扫描其他对象类型。 |
