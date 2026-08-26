# apps/api 迁移说明

本目录当前包含此前开始编写的 NestJS/TypeORM 后端骨架。2026-08-26 起，正式后端目标已经切换为：

- .NET 10 / ASP.NET Core 10 Controller Web API；
- EF Core 10 + Microsoft.EntityFrameworkCore.SqlServer + Microsoft.Data.SqlClient；
- SQL Server 2016 SP2 及之后版本，数据库兼容级别不低于 130；
- 原生 .NET Windows Service + Kestrel loopback + IIS/ARR；
- System.DirectoryServices.Protocols、PasswordHasher<TUser>、MailKit、Serilog 和 BackgroundService；
- Riok.Mapperly 编译期对象映射；
- 外置 `appsettings.Production.json` 与 `secrets.Production.json`。
- 生产发布放入 `{部署根目录}\App\releases\{releaseId}\api`，并与同一发布包中的 `web` 统一通过 `App\current` 目录联接切换；生产路径从 `AppContext.BaseDirectory` 向上有限层级查找 `flowpilot.root`，不使用 `FLOWPILOT_HOME` 或配置文件路径覆盖参数。

现有 TypeScript 源码、TypeORM migration、`.env` 模板和 pnpm 脚本均属于待替换的旧实现，不能继续作为生产部署依据。本轮只同步文档，尚未创建 .NET solution，也未删除旧代码。

后续迁移必须遵循：

- [统一需求](../../REQUIREMENTS.md)
- [.NET 后端实现设计](../../document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [.NET 后端实施清单](../../document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [数据库结构](../../document/BACKEND_DATABASE_SCHEMA.md)
- [IIS 部署指南](../../document/IIS_DEPLOYMENT.md)
- [OpenAPI 契约](../../document/flowpilot-rest-api.openapi.yaml)

在 .NET 迁移完成前，不要使用本目录旧的 `pnpm dev`、TypeORM migration、NestJS Windows Service 或 `.env` 配置说明进行正式部署。
