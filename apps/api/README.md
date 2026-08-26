# FlowPilot ASP.NET Core API

`apps/api/FlowPilot.sln` 是正式后端解决方案。之前的 NestJS/TypeORM 试验骨架已删除，当前已落地 .NET 工程基础、分层项目与健康检查切片。认证会话、组织权限、流程定义、实例任务、附件、Outbox 和审计等业务接口尚未实现，不能视为可部署的完整后端。

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
pnpm dev:api
pnpm build:api
pnpm test:api
pnpm publish:api
pnpm backend:check
```

`pnpm publish:api` 将 `win-x64`、framework-dependent 的 Release 产物写入 `apps/api/artifacts/publish`；该目录只是本地发布暂存，不是包含 `api + web + release.json` 的正式统一部署包，也不提交 Git。`pnpm backend:check` 依次检查 OpenAPI 合同、还原 NuGet 依赖、Release 构建并运行 .NET 测试。

SQL Server 集成测试默认跳过，避免误连共享数据库。要对已初始化的专用测试库运行兼容性、排序规则、schema 和版本账本检查，请设置 `FLOWPILOT_SQLSERVER_TEST_CONNECTION_STRING`、`FLOWPILOT_SQLSERVER_TEST_REQUIRED_SCHEMA_VERSION` 与 `FLOWPILOT_SQLSERVER_TEST_EXPECTED_COLLATION` 后执行 `pnpm test:api`；连接字符串不得写入仓库。

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

健康检查只证明当前工程切片可启动和检查基础依赖，不代表认证、数据库 schema、LDAP、SMTP、附件存储或业务事务已完成。
