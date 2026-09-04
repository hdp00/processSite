# FlowPilot ASP.NET Core API

后端位于 `apps/api/FlowPilot.slnx`。旧 NestJS 代码已删除，目前已具备：

- .NET 10 Controller Web API；
- SQL Server 结构初始化和校验；
- 内置权限、超级管理员和基础字典初始化；
- `POST /auth/login`、`GET /auth/me`、`POST /auth/logout`，以及超级管理员模拟身份候选、开始和结束接口；
- 部门和职务的目录、详情、新增、编辑、启停及受引用保护的删除；
- 用户列表、详情、创建、编辑、启停、密码重置和受引用保护的删除；
- 角色列表、详情、创建、编辑、删除、权限矩阵和变更影响预览；
- 流程权限组列表、详情、新增、修改、删除及有效成员查询；
- `GET /me/workflow-tasks` 任务中心待办/可代办查询；
- `GET /workflow-tasks/{taskId}` 和审批任务通过、确认、驳回处理；
- `POST /workflow-tasks/{taskId}/field-revisions` 审批结果提交后的授权字段重复修改；
- `GET /process-instances` 流程实例列表及“我的发起”查询；
- `GET /process-instances/{instanceId}` 按实例数据范围读取锁定版本表单、任务、时间线和附件；
- `GET /process-definitions`、定义详情、版本列表和完整版本快照；
- `POST /process-definitions`，以及 V1 基本信息、表单、流程图保存、重新校验、发布和取消发布；
- 流程定义启停、删除、复制、新版本、历史版本删除，以及完整 JSON 导入和导出；
- `GET /me/launchable-process-definitions` 和发布版本发起配置，按当前有效成员过滤流程并返回处理人候选；
- `POST /process-instances` 原子锁定发布版本、分配月度编号、保存表单、生成首轮任务与时间线；
- `PATCH /process-instances/{instanceId}/submission` 在首个审核结果前原子修改表单、附件和默认责任人；
- `POST /process-instances/{instanceId}/resubmissions` 在驳回后保存内容并创建完整新审核轮次；
- `POST /process-instances/{instanceId}/close` 按关闭动作权限和锁定版本权限组关闭审批流程，并取消未完成任务；
- 自由协作事项支持发表文字回复，以及可选回复内容的原子变更受理人；变更会完成原待办并为新受理人创建待办；
- `POST /attachments`、附件元数据/内容读取和暂存删除，支持流式写入、字段策略校验与单 Range 下载；
- `GET /me/visible-process-definitions` 按流程发起、任务/清单或实例监控数据范围返回定义及所需版本快照；
- 邮件 Outbox 查询、详情和幂等手工重试，操作审计查询，以及流程清单 Excel 数据集；
- LDAP 域账号登录、MailKit SMTP 后台发送，以及附件、会话、幂等记录和已发送邮件的定时清理；
- 受运维权限保护的 `GET /health/details` 脱敏运行状态；
- 存活与就绪检查。

代码默认保持简单：`Controller → Service → EF Core/少量参数化 SQL`，不预先增加 CQRS、通用仓储或事件总线。

## 本地配置

首次调试时，从仓库根目录执行：

```powershell
Copy-Item apps/api/config/appsettings.Development.local.example.json apps/api/config/appsettings.Development.local.json
```

只需在这个被 Git 忽略的 JSON 文件中填写：

- `ConnectionStrings:FlowPilot`：API 运行账号；
- `ConnectionStrings:FlowPilotMigration`：初始化和 Seed 账号；
- `FlowPilot:Database:ExpectedCollation`：目标数据库排序规则；
- `FlowPilot:Bootstrap:SuperAdminPassword`：首次创建 `superadmin` 时使用。
- `FlowPilot:Ldap`：存在域登录用户时填写 LDAP 地址、Base DN 和 UPN 后缀；当前内网部署使用 `ldap://` 时还必须显式设置 `AllowPlainText=true`；
- `FlowPilot:Smtp`：需要发信时填写服务器、TLS、账号和固定发件人，并把 `Enabled` 改为 `true`。联调时可填写 `TestEMail`，所有通知只投递到该测试邮箱；留空则使用用户实际邮箱。

附件调试目录默认是 `apps/api/.local-data/Attachments`，已被 Git 忽略。通常无需配置；需要放到其他磁盘时，可在同一 JSON 中设置 `FlowPilot:Attachments:RootDirectory`，相对路径以 `apps/api` 为基准。

Development API、数据库工具和本地调试共用该文件，不要求逐项设置环境变量。LDAP 和 SMTP 不参与当前调试时可以保留示例值并让 SMTP 维持禁用；环境变量和命令行参数仍可作为临时覆盖。真实密码不得写入示例文件或提交 Git。

数据库结构版本和内置数据版本由后端代码统一维护，不属于环境配置，无需在本地或生产 JSON 中填写。`db:init`、`db:seed`、`db:verify` 和就绪检查始终使用当前代码要求的版本，避免配置与程序不一致。

当前部署环境明确使用隔离内网中的 SQL Server，并采用 `Encrypt=false;TrustServerCertificate=true`。开发和生产配置都必须显式写出这两个值，避免依赖 SqlClient 版本默认值；该设置不提供传输加密，只能用于已确认并接受风险的内网环境。

数据库需要先在 SQL Server 中创建好，并设置兼容级别不低于 130；工具不会创建或删除数据库。

## 初始化数据库

按顺序执行：

```bash
pnpm db:init
pnpm db:seed
pnpm db:verify
```

- `db:init` 创建或升级 `flowpilot` schema；重复执行当前版本为 no-op。
- `db:seed` 幂等创建“经理”“员工”两个初始职务、29 项权限、超级管理员角色和 `superadmin`；不创建“系统内部”部门或职务占位项。已有超级管理员密码不会被覆盖。
- `db:verify` 使用运行账号检查连接、版本、迁移账本和结构名称清单。

首次 Seed 成功后可以从本地配置中删除 `SuperAdminPassword`；后续重复执行 Seed 不再需要它。

## 启动和调试

后端：

```bash
pnpm dev:api
```

该命令使用 .NET 10 的 `dotnet watch`。保存支持热重载的 C# 修改后会直接更新运行中的 API；无法热重载的修改会提示或自动重启进程，也可以在运行终端按 `Ctrl+R` 手动重启。项目文件、依赖、数据库结构以及 `appsettings.Development.local.json` 的修改应按提示重启；数据库迁移和 Seed 仍需使用上面的显式命令执行。

真实后端模式前端（另开终端）：

```bash
pnpm dev:remote
```

浏览器打开 `http://127.0.0.1:5173/flowpilot/`。Vite 会把 `/api/flowpilot/*` 同源代理到本地 API，因此 Cookie 和 CSRF 校验可以直接调试。

常用地址：

- `http://127.0.0.1:3000/api/flowpilot/v1/health/live`
- `http://127.0.0.1:3000/api/flowpilot/v1/health/ready`

使用 Visual Studio 或 Rider 时打开 `apps/api/FlowPilot.slnx`，以 `FlowPilot.Api` 启动调试；数据库初始化仍使用上面的三个显式命令，API 启动不会自动迁移或 Seed。

## 当前可调试范围

- `superadmin` 使用本地密码登录；
- Cookie 名为 `flowpilot_session`，数据库只保存令牌 SHA-256；
- 会话闲置 8 小时、绝对 24 小时；
- 登录和注销执行同源校验；
- 真实登录操作者为内置超级管理员时，可以查询启用的非内置用户并在当前服务端会话中开始或结束模拟身份。模拟期间权限和数据范围只按目标用户计算，会话保留真实操作者、模拟记录和审计；多个浏览器会话各自关联自己的模拟记录。
- 已配置为域登录的用户使用本地 JSON 中的 LDAP 配置校验；服务不可用或配置不完整返回明确的 503，账号密码错误返回 401，且不会回退本地密码。
- 登录后可查询任务中心的“我的待办”“可代办”和“我的发起”；待办列表按流程实例分页，同一实例的并行任务放在同一个 `tasks` 数组中。
- 审批人可读取单个任务并按任务 ETag 提交通过、确认或驳回。服务端动态校验当前流程权限组成员资格，以首个成功写入者为准，并在一个事务中保存授权字段和附件、实际处理人、后续节点激活、并行待办取消、实例状态、时间线和审计。驳回按锁定版本进入待重新提交或自动关闭。
- 节点开启“允许重复修改”后，原实际处理人或超级管理员可继续修改本节点授权字段和附件；原通过/确认结果保持不变，不重新激活任务或节点。每次保存只记录修改人、时间、说明及字段标识/名称，不保存旧值和新值。
- 流程管理员可分页读取定义摘要、定义详情、版本摘要和完整 JSON 快照；定义和版本详情返回 revision ETag。
- 流程管理员可创建定义和正式 V1，按 ETag 保存基本信息、表单与流程图，并重新执行完整校验；可在权威校验通过后原子发布或切换版本，也可填写原因后取消发布。创建、重新校验和发布生命周期命令要求 Idempotency-Key。
- 流程发起中心只返回未停用、发布版本依赖可用且当前用户有发起资格的流程；发起配置返回当前发布完整快照，审批人和自由协作受理人候选按权限组当前有效成员动态计算，超级管理员不进入候选列表。
- 实例创建要求 `Idempotency-Key`，在一个可串行化事务内重新校验发布版本与发起资格、分配 `前缀 + YYMM + 四位流水号`、保存表单与查询投影、展开固定审批首轮任务或自由协作首位受理任务，并写入实例时间线和治理审计。
- 发起前附件上传要求 `Idempotency-Key` 以及当前发布版本的 `definitionId/versionId/fieldId`；实例编辑和审批字段修改改用 `instanceId/fieldId`，服务端按当前状态、发起人或待办授权校验。文件直接流式写入按年分层的 `.incoming`，同时校验 100 MB 系统上限、字段上限、扩展名、PDF/MZ 内容签名并计算 SHA-256；业务命令再把暂存附件转为有效引用。元数据和内容读取执行上传人或实例数据范围校验，内容接口支持单 Range；替换后不再引用的附件进入待清理状态。
- 首个通过、确认或驳回结果产生前，实际创建人可携带实例 ETag 保存完整发起表单、附件字段映射和发起时指定的默认责任人。服务端按实例锁定版本重新校验，并同步刷新字段查询投影、条件节点状态、字段修订号、时间线和审计记录；超级管理员可修改任意符合状态要求的实例。
- 驳回待处理实例可由实际创建人或超级管理员携带 ETag 和 `Idempotency-Key` 重新提交。服务端完成当前待重新提交任务，保留上一轮审核记录和默认责任人，按实例锁定版本创建完整下一轮审批任务，并原子更新表单、附件、查询投影、时间线和审计；重新提交不能借机修改默认责任人。
- 审批流程关闭要求实例 ETag、`Idempotency-Key`、“任务中心-关闭”动作权限和锁定版本关闭权限组资格。成功后实例进入不可恢复的已关闭状态，所有未激活或待处理任务在同一事务取消，并记录关闭原因、时间线和审计；“仅允许重新提交”的驳回实例不能关闭。
- 进行中的自由协作事项支持参与人发表文字回复并添加最多20个附件；回复附件使用 `purpose=free-reply` 和 `instanceId` 暂存，回复提交时原子建立时间线引用。实例锁定版本发起组或受理组的当前有效成员可指定受理组的另一名有效成员，不要求是发起人或当前受理人。回复与变更受理人支持一次原子提交，并同步更新当前受理人、唯一待办、参与人投影、时间线、审计和实例 ETag。
- 进行中的自由协作回复只能由原作者按实例 ETag 编辑；保存会覆盖为最新正文，不保留旧正文，并同步记录编辑人、编辑时间、编辑事件、审计和实例更新时间。无变化保存不会产生伪更新。
- 进行中的自由协作初始表单可由实际发起人或超级管理员按实例 ETag 修改。服务端复用统一表单与附件校验，保留当前受理人和待办，并更新字段修订号、列表投影、字段名称时间线、审计与实例更新时间；不保存字段修改前后的业务值。
- 进行中的自由协作事项可由具备关闭动作权限且属于锁定版本关闭权限组的当前有效成员关闭。关闭要求实例 ETag、`Idempotency-Key` 和原因，并原子取消当前待办、清空当前受理人、更新时间线与审计；发起人或受理人身份不会自动获得关闭资格。
- 已关闭的自由协作事项可由锁定版本发起权限组当前成员、历史参与人或超级管理员重新打开。操作要求实例 ETag、`Idempotency-Key`、原因和有效受理人，并原子恢复进行中状态、创建唯一当前待办、更新参与人投影、时间线与审计。
- 实例详情始终使用实例锁定的版本解释表单和节点，并返回当前任务、审批进度、流程/自由协作时间线、附件与列表投影。普通用户只有作为发起人、参与人、任务处理人、锁定版本权限组成员或额外可见对象时才能读取；实例监控权限可查看全部实例。
- 用户管理支持分页目录、详情、创建、编辑、启停、密码重置和删除；部门、职务和角色可为空。超级管理员账号保持只读，停用、登录方式切换和密码重置会按规则使用户会话失效，删除前检查可变配置与历史业务引用。
- 角色支持目录、详情、创建、编辑、启停、删除和权限矩阵维护；成员或状态变更前可预览失去流程权限组资格的用户和受影响待办，内置角色保持只读，删除前检查用户、流程权限组和所有流程版本引用。
- 部门支持最多两级、同级名称唯一、路径联动更新和子部门/用户引用保护；职务支持全局名称唯一、排序、启停及用户引用保护。
- 流程权限组支持用途、直接用户、关联角色、状态的完整增删改查，以及动态有效成员查询；被流程版本引用的用途和权限组受外键与业务校验保护。
- 普通用户的可见定义接口只返回当前发布版本，以及其可见实例实际锁定的历史版本完整快照；任务中心可据此读取列表列和节点处理方式。
- 当前 Seed 只创建内置身份，不创建流程权限组。可先通过管理页面或 API 创建用途匹配且含有效成员的发起、关闭（自由流程另需审批/受理）权限组，再创建并校验流程。在尚未写入流程定义、实例和任务数据时，相关列表会正常返回空分页，而不是返回占位数据。
- SMTP 默认关闭。启用后，后台服务根据流程节点通知配置生成 Outbox，通过 STARTTLS 发送并自动重试；邮件投递和死信可在系统监控接口查看并手工重试。

## 其他命令

```bash
pnpm restore:api
pnpm build:api
pnpm publish:api
```

生产配置、IIS 和完整契约见：

- [后端实现设计](../../document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [数据库结构](../../document/BACKEND_DATABASE_SCHEMA.md)
- [后端生产部署 Runbook](../../document/BACKEND_DEPLOYMENT_RUNBOOK.md)
- [后端首次安装向导](../../deployment/Install-FlowPilotBackend.ps1)
- [IIS 部署指南](../../document/IIS_DEPLOYMENT.md)
- [OpenAPI 契约](../../document/flowpilot-rest-api.openapi.yaml)
