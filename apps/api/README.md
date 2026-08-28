# FlowPilot ASP.NET Core API

后端位于 `apps/api/FlowPilot.slnx`。旧 NestJS 代码已删除，目前已具备：

- .NET 10 Controller Web API；
- SQL Server 结构初始化和校验；
- 内置权限、超级管理员和基础字典初始化；
- `POST /auth/login`、`GET /auth/me`、`POST /auth/logout`；
- 部门和职务的目录、详情、新增、编辑、启停及受引用保护的删除；
- 用户列表、详情、创建、编辑、启停、密码重置和受引用保护的删除；
- 角色列表、详情、创建、编辑、删除、权限矩阵和变更影响预览；
- 流程权限组列表、详情、新增、修改、删除及有效成员查询；
- `GET /me/workflow-tasks` 任务中心待办/可代办查询；
- `GET /process-instances` 流程实例列表及“我的发起”查询；
- `GET /process-definitions`、定义详情、版本列表和完整版本快照；
- `POST /process-definitions`，以及 V1 基本信息、表单、流程图保存和重新校验；
- `GET /me/visible-process-definitions` 按流程发起、任务/清单或实例监控数据范围返回定义及所需版本快照；
- 存活与就绪检查。

普通用户域登录、流程发布、实例详情和实例业务写操作仍需按纵向切片继续实现。代码默认保持简单：`Controller → Service → EF Core/少量参数化 SQL`，不预先增加 CQRS、通用仓储或事件总线。

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

Development API、数据库工具和本地调试共用该文件，不要求逐项设置环境变量。环境变量和命令行参数仍可作为临时覆盖。真实密码不得写入示例文件或提交 Git。

示例连接字符串只面向 `127.0.0.1` 本机调试，默认使用 `Encrypt=false`，避免本机 SQL Server 没有可用 TLS 凭据时无法建立连接。连接远程数据库或部署时必须使用 `Encrypt=true;TrustServerCertificate=false` 和与服务器名称匹配的可信证书；不要把本地例外复制到生产配置。

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
- 已配置为域登录的用户在 LDAP 切片完成前返回明确的 503，不会假装登录成功，也不会回退本地密码。
- 登录后可查询任务中心的“我的待办”“可代办”和“我的发起”；待办列表按流程实例分页，同一实例的并行任务放在同一个 `tasks` 数组中。
- 流程管理员可分页读取定义摘要、定义详情、版本摘要和完整 JSON 快照；定义和版本详情返回 revision ETag。
- 流程管理员可创建定义和正式 V1，按 ETag 保存基本信息、表单与流程图，并重新执行完整校验；创建和重新校验要求 Idempotency-Key。
- 用户管理支持分页目录、详情、创建、编辑、启停、密码重置和删除；部门、职务和角色可为空。超级管理员账号保持只读，停用、登录方式切换和密码重置会按规则使用户会话失效，删除前检查可变配置与历史业务引用。
- 角色支持目录、详情、创建、编辑、启停、删除和权限矩阵维护；成员或状态变更前可预览失去流程权限组资格的用户和受影响待办，内置角色保持只读，删除前检查用户、流程权限组和所有流程版本引用。
- 部门支持最多两级、同级名称唯一、路径联动更新和子部门/用户引用保护；职务支持全局名称唯一、排序、启停及用户引用保护。
- 流程权限组支持用途、直接用户、关联角色、状态的完整增删改查，以及动态有效成员查询；被流程版本引用的用途和权限组受外键与业务校验保护。
- 普通用户的可见定义接口只返回当前发布版本，以及其可见实例实际锁定的历史版本完整快照；任务中心可据此读取列表列和节点处理方式。
- 当前 Seed 只创建内置身份，不创建流程权限组。可先通过管理页面或 API 创建用途匹配且含有效成员的发起、关闭（自由流程另需审批/受理）权限组，再创建并校验流程。在尚未写入流程定义、实例和任务数据时，相关列表会正常返回空分页，而不是返回占位数据。

## 其他命令

```bash
pnpm restore:api
pnpm build:api
pnpm publish:api
```

生产配置、IIS 和完整契约见：

- [后端实现设计](../../document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [数据库结构](../../document/BACKEND_DATABASE_SCHEMA.md)
- [IIS 部署指南](../../document/IIS_DEPLOYMENT.md)
- [OpenAPI 契约](../../document/flowpilot-rest-api.openapi.yaml)
