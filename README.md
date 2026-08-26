# FlowPilot 流程审核平台

当前可运行部分是 React 前端交互原型，开发环境默认启用浏览器内 Mock REST API，无需启动后端即可演示登录、流程定义、实例、任务、附件、邮件 Outbox、审计和 Excel 导出。

正式后端目标架构已确定为 .NET 10 / ASP.NET Core 10 Controller Web API、EF Core 10 和 SQL Server 2016 SP2 及之后版本。仓库中现有 `apps/api` 是此前的 NestJS 试验骨架，尚未迁移，不能视为当前目标实现或生产后端。本次架构切换先完成文档同步，后续再替换后端代码。

- [统一需求](REQUIREMENTS.md)
- [Mock REST API 使用说明](document/MOCK_REST_API.md)
- [IIS 与 .NET Windows Service 部署说明](document/IIS_DEPLOYMENT.md)
- [.NET 正式后端实现设计](document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [SQL Server 数据库结构](document/BACKEND_DATABASE_SCHEMA.md)
- [.NET 后端实施清单](document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [OpenAPI 3.1 契约](document/flowpilot-rest-api.openapi.yaml)
- [自动化测试策略](document/TEST_STRATEGY.md)

## 前端开发

```bash
pnpm install
pnpm dev
```

开发入口为 `http://127.0.0.1:5173/flowpilot/`。要连接后续 .NET API，可在被 Git 忽略的 `apps/web/.env.remote.local` 中设置 `VITE_API_PROXY_TARGET`，前端仍请求同源 `/api/flowpilot/v1`。

构建命令按数据来源分开：

```bash
# 正式包：请求同源 /api/flowpilot/v1，由 IIS 代理到 ASP.NET Core
pnpm build

# HTTP 演示包：使用页面内 Mock，不注册 Service Worker
pnpm build:debug
```

## 正式后端目标

- 后端位置继续为 `apps/api`，但使用独立 .NET solution 和 NuGet；前端继续使用 pnpm。
- 持久化实体、领域模型和 API DTO 之间使用 Mapperly 编译期生成映射；业务命令和领域规则不交给映射器执行。
- Kestrel 仅监听 loopback，以原生 .NET Windows Service 运行，IIS 托管 `/flowpilot` 并反代 `/api/flowpilot/*`；不使用 WinSW。
- 数据库支持 SQL Server 2016 SP2 及之后版本，数据库兼容级别不低于 130；共享 SQL 和迁移以 2016 SP2/兼容级别 130 为最低能力基线。不支持 SQLite，也不制定服务器或 SQL Server 升级计划。
- 生产发布采用不可变的 `{部署根目录}\App\releases\{releaseId}` 发布包，每个发布包同时包含 `api` 与 `web`；`App\current` 和 `App\previous` 使用本机 NTFS 目录联接，API 与 Web 作为同一兼容版本统一切换和回滚。
- Windows Service 固定运行 `App\current\api\FlowPilot.Api.exe`，IIS `/flowpilot` 固定指向 `App\current\web`。应用从 `AppContext.BaseDirectory` 向上有限层级查找 `{部署根目录}\flowpilot.root`，不需要 `FLOWPILOT_HOME` 或配置路径参数。
- 外置配置为 `{部署根目录}\Config\appsettings.Production.json` 和 `{部署根目录}\Secrets\secrets.Production.json`；真实文件禁止进入 Git。
- 附件位于程序目录之外的 `{部署根目录}\Data\Attachments\{yyyy}`，例如 2026 年附件进入 `2026` 目录。
- OpenAPI YAML 保持唯一对外契约；Orval 生成前端 TypeScript/Axios 客户端，C# DTO 和校验由 ASP.NET Core 实现并通过语义契约测试。

后端尚未迁移前，不要继续使用旧 NestJS 的 `pnpm dev:api`、`.env`、TypeORM migration 或 WinSW 部署流程。

## 测试

```bash
pnpm test
pnpm test:coverage
pnpm test:coverage:all
pnpm test:e2e
pnpm test:e2e:edge
pnpm test:all
```

后续 .NET 工程增加 `dotnet test`，并在真实 SQL Server 2016 SP2/兼容级别 130 最低基线以及实际部署的较新 SQL Server 版本上运行数据库集成测试。现有 Mock/前端测试不能代替正式后端的事务、LDAP、SMTP、磁盘附件或 Windows Service 验收。
