# FlowPilot ASP.NET Core API

`apps/api/FlowPilot.sln` 是正式后端解决方案。之前的 NestJS/TypeORM 试验骨架已删除，当前已落地 .NET 工程基础、分层项目、健康检查、完整首版 SQL Server 结构基线和显式数据库初始化工具。内置数据种子、认证会话及其他业务 API 尚未实现，不能视为可部署的完整后端。

目标技术栈为：

- .NET 10 / ASP.NET Core 10 Controller Web API；
- EF Core 10 + Microsoft.EntityFrameworkCore.SqlServer + Microsoft.Data.SqlClient；
- SQL Server 2016 SP2 及之后版本，数据库兼容级别不低于 130；
- 原生 .NET Windows Service + Kestrel loopback + IIS/ARR；
- System.DirectoryServices.Protocols、PasswordHasher<TUser>、MailKit、Serilog 和 BackgroundService；
- Riok.Mapperly 编译期对象映射；
- 外置 `appsettings.Production.json` 与 `secrets.Production.json`。
- 生产发布放入 `{部署根目录}\App\releases\{releaseId}\api`，并与同一发布包中的 `web` 统一通过 `App\current` 目录联接切换；生产路径从 `AppContext.BaseDirectory` 向上有限层级查找 `flowpilot.root`，不使用 `FLOWPILOT_HOME` 或配置文件路径覆盖参数。

从仓库根目录运行：

```bash
pnpm restore:api
pnpm db:init
pnpm db:verify
pnpm dev:api
pnpm build:api
pnpm test:api
pnpm publish:api
pnpm backend:check
```

`pnpm publish:api` 将 `win-x64`、framework-dependent 的 Release 产物写入 `apps/api/artifacts/publish`；该目录只是本地发布暂存，不是包含 `api + web + release.json` 的正式统一部署包，也不提交 Git。`pnpm backend:check` 依次检查 OpenAPI 合同、还原 NuGet 依赖、Release 构建并运行 .NET 测试。

## Development 本地调试配置

需要连接本机 SQL Server 时，将
[`config/appsettings.Development.local.example.json`](config/appsettings.Development.local.example.json)
复制为 `config/appsettings.Development.local.json`，再只在该本地文件中填写调试配置。目标文件已被 Git 忽略，并与数据库初始化工具复用；不要把真实连接字符串或其他秘密写入示例文件、`appsettings.json` 或提交记录。

在仓库根目录首次执行：

```powershell
Copy-Item apps/api/config/appsettings.Development.local.example.json apps/api/config/appsettings.Development.local.json
```

示例连接使用 `127.0.0.1`，因此保留加密但允许信任本机 SQL Server 的开发证书。连接远程数据库时必须改为 `TrustServerCertificate=false`，并使用与服务器名称匹配的可信证书。

连接字符串显式给出 `Connection Timeout=15`、`Min Pool Size=0` 和 `Max Pool Size`。运行账号默认池上限为 100，迁移账号默认池上限为 20；这些是每个进程、每个精确连接字符串对应的池参数，可在本地私有配置或生产 Secrets 中按 DBA 容量评估调整，不能把密码移到非敏感配置。

`FlowPilot:Database` 中的命令超时使用强类型配置，均可被本地 JSON、生产 Config、环境变量或命令行配置值覆盖，允许范围为 1–3600 秒：常规 EF 命令默认 30 秒，就绪元数据与种子查询默认 5 秒，完整结构探测默认 15 秒，迁移预检默认 15 秒，迁移 DDL 默认 300 秒。连接建立超时仍由连接字符串的 `Connection Timeout` 控制；修改后重启对应 API 或数据库工具进程。

API 仅在 `Development` 环境自动读取该文件；文件不存在时仍可启动。配置覆盖优先级为：仓库默认配置 < `appsettings.Development.local.json` < 环境变量 < 命令行参数。因此 CI、启动配置和临时命令行参数始终可以覆盖本地 JSON。修改配置后需重启 `pnpm dev:api`，本地文件不会在进程运行期间热重载。

数据库工具只从自身程序集所在的仓库工程布局定位 API 默认配置和这个本地文件，不读取当前工作目录，也不接受其他配置文件路径。确有需要时可在 `initialize`/`verify` 后使用 .NET 风格的 `--Key=Value` 临时覆盖非敏感值；连接字符串和密码应继续放在被忽略的本地 JSON 中，避免出现在命令历史或进程参数里。

本地文件中的 `ConnectionStrings:FlowPilotMigration` 供显式初始化工具使用，`ConnectionStrings:FlowPilot` 供 API、验证工具和 SQL Server 集成测试使用。正式环境必须分离迁移账号与低权限运行账号；仅用于个人专用空库的早期调试，可以暂时填写同一个具备建表权限的开发账号。

数据库本身必须先由开发者或 DBA 创建，并设置兼容级别和排序规则；工具不会创建、删除或修改数据库级设置。填写配置后按以下顺序执行：

```bash
pnpm db:init
pnpm db:verify
pnpm dev:api
```

使用 Visual Studio/Rider 调试时打开 `apps/api/FlowPilot.sln`：数据库工具可选择 `Initialize` 或 `Verify` 启动配置，API 选择 `FlowPilot.Api` 后直接 F5。三个入口读取同一个本地 JSON，不需要分别设置多组环境变量。

`pnpm db:init` 只对空的专用数据库或已经处于相同迁移 ID/校验和且结构清单完全匹配的数据库成功：它先检查 SQL Server 版本、兼容级别和排序规则，再在事务级独占锁内创建完整 `flowpilot` schema、34 张表、356 列、283 个具名约束、86 个显式索引、6 个触发器和迁移账本。提交前会根据版本化清单核对全部这些对象，并拒绝 `flowpilot` schema 中的额外对象。相同版本重复运行是 no-op；部分结构、未知版本、非成功账本或校验和漂移会拒绝继续。API 启动永远不会自动迁移。

`pnpm db:verify` 使用运行连接字符串执行只读连接、数据库版本、排序规则、迁移账本和完整结构清单检查。生产运行账号除业务所需 DML/执行权限外，还需能读取 `flowpilot.schema_migrations`、`flowpilot.system_state`，并由 DBA 授予 `GRANT VIEW DEFINITION ON SCHEMA::[flowpilot]`，使其可以核对约束、索引和触发器定义；它不需要也不应拥有 DDL 权限。

当前初始化只创建结构，尚未实现内置种子。因此 `pnpm db:verify` 成功后，可以确认数据库已经连接并具备正确结构；但运行 API 后访问 `http://127.0.0.1:3000/api/flowpilot/v1/health/ready` 会按设计返回 `503 / DATABASE_BUILTIN_SEED_VERSION_MISSING`。这不是连接失败，而是防止把尚未完成认证种子的后端误报为完整就绪；`/health/live` 仍可用于调试 API 进程。

SQL Server 集成测试会优先读取同一个本地 JSON；也可以使用 `FLOWPILOT_SQLSERVER_TEST_CONNECTION_STRING`、`FLOWPILOT_SQLSERVER_TEST_REQUIRED_SCHEMA_VERSION` 与 `FLOWPILOT_SQLSERVER_TEST_EXPECTED_COLLATION` 临时覆盖。这三个值会统一映射到测试进程中的 `ConnectionStrings:FlowPilot`、目标结构版本和预期排序规则，因此 readiness 用例与迁移测试的数据库隔离比较看到的是同一个最终运行目标。日常 `pnpm test:api` 在未配置 SQL Server 时跳过真实数据库用例，避免误连共享数据库。

要执行完整数据库门禁，再由 DBA 创建一个名称以 `_Tests` 或 `_MigrationTests` 结尾、且没有任何用户对象的专用测试库，并把迁移账号连接填入可选的 `ConnectionStrings:FlowPilotMigrationTest`。`pnpm backend:check` 会强制要求开发库和这个测试库均已配置，并读取 SQL Server 返回的实际服务器/数据库身份，拒绝测试连接与开发或运行库重合。首版 SQL、账本和重复执行状态会在事务中真实验证后整体回滚，测试库仍保持为空；随后还会注入一次 DDL 失败并再次验证回滚。该测试库不得与开发库或任何共享业务库相同。

当前初始化命令只完成结构迁移，不创建数据库登录、不授予环境权限，也不创建超级管理员和其他内置种子数据。种子命令将在认证纵向切片中实现；不要手工插入密码或内置权限数据。

生产部署时，在部署根创建空的 `flowpilot.root` 标记文件，并分别从
[`config/appsettings.Production.example.json`](config/appsettings.Production.example.json) 和
[`config/secrets.Production.example.json`](config/secrets.Production.example.json) 创建仓库外的
`Config/appsettings.Production.json` 与 `Secrets/secrets.Production.json`。真实配置和秘密不得复制回仓库。

后续实现必须遵循：

- [统一需求](../../REQUIREMENTS.md)
- [.NET 后端实现设计](../../document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [.NET 后端实施清单](../../document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [数据库结构](../../document/BACKEND_DATABASE_SCHEMA.md)
- [IIS 部署指南](../../document/IIS_DEPLOYMENT.md)
- [OpenAPI 契约](../../document/flowpilot-rest-api.openapi.yaml)

就绪检查会验证 SQL Server 版本、排序规则、结构账本、完整结构清单和内置种子版本；它不代表 LDAP、SMTP、附件存储或业务事务已经完成。
