# FlowPilot 流程审核平台原型

前端开发环境默认启用浏览器内 Mock REST API，无需启动后端即可演示登录、流程定义、实例、任务、附件、邮件 Outbox、审计和 Excel 导出。

仓库已经开始实现正式后端。当前纵向链路包括 OpenAPI 生成契约、SQL Server 身份与会话表迁移、内置目录与超级管理员种子、健康检查、本地密码与 AD/LDAP 登录、退出和当前会话，以及角色、权限、流程权限组和组织目录读取；同时已提供固定发件人的 Nodemailer SMTP 网关供后续 Outbox worker 调用。流程运行、附件、邮件 Outbox/重试 worker 和完整管理写接口仍按后端实施清单继续开发，不能把当前版本视为完整生产后端。

- [Mock REST API 使用说明](document/MOCK_REST_API.md)
- [IIS 部署说明](document/IIS_DEPLOYMENT.md)
- [正式后端实现设计](document/BACKEND_IMPLEMENTATION_DESIGN.md)
- [SQL Server 数据库结构](document/BACKEND_DATABASE_SCHEMA.md)
- [后端实施决策与开工清单](document/BACKEND_IMPLEMENTATION_CHECKLIST.md)
- [OpenAPI 3.1 契约](document/flowpilot-rest-api.openapi.yaml)

```bash
pnpm install
pnpm dev
```

## 本地联调正式后端

后端配置必须从仓库外的 `{FLOWPILOT_HOME}\Config\application.env` 与 `{FLOWPILOT_HOME}\Secrets\production.env` 提供；本地开发先把 `FLOWPILOT_HOME` 指向该外置根目录，也可以分别设置 `FLOWPILOT_CONFIG_FILE` 与 `FLOWPILOT_SECRETS_FILE` 的绝对路径。仓库只保留 [`apps/api/config`](apps/api/config) 中的占位示例。首次初始化时临时提供 `FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD`，种子只在超级管理员尚不存在时读取并写入散列，重复执行不会覆盖现有密码。

本地 API 未使用默认 `127.0.0.1:3000` 时，在被 Git 忽略的 `apps/web/.env.remote.local` 中用 `VITE_API_PROXY_TARGET` 覆盖前端开发代理目标。

`db:bootstrap` 只初始化已存在的数据库，不执行 `CREATE DATABASE`。运行前由 DBA 创建目标数据库、设置不低于 130 的兼容级别和已确认排序规则，并分别提供高权限迁移账号与最小 DML 运行账号；常驻应用账号不得使用 `sysadmin`。

```bash
# 对已创建的 SQL Server 2016 SP2 以上、兼容级别不低于 130 的数据库执行迁移和种子
pnpm --filter @process-site/api db:bootstrap

# 分别启动 NestJS API 与使用真实 REST API 的前端
pnpm dev:api
pnpm dev:remote
```

当前固定使用 `mssql` 的 `tedious` 驱动，只支持 TCP/IP SQL Server，不支持 `(localdb)\...` LocalDB 命名管道；检测到该配置时返回 `UNSUPPORTED_LOCALDB_DRIVER`，不会尝试创建或修改数据库。更多配置、初始化和验证边界见 [`apps/api/README.md`](apps/api/README.md)。

构建命令按数据来源严格分开：

```bash
# 正式包：请求同源 /api/flowpilot/v1，由 IIS 代理到后端
pnpm build

# HTTP 演示包：使用页面内 Mock，不注册 Service Worker
pnpm build:debug
```

## 本地测试

```bash
# 单元、领域集成与组件测试
pnpm test

# 覆盖率门禁
pnpm test:coverage

# 全源码覆盖率报告（页面由 E2E 负责，不作为 Vitest 百分比门禁）
pnpm test:coverage:all

# Chromium 全量端到端与 Edge 冒烟
pnpm test:e2e
pnpm test:e2e:edge

# 类型、覆盖率、双构建与浏览器全量门禁
pnpm test:all
```

首次运行浏览器测试前执行 `pnpm --filter @process-site/web exec playwright install chromium`。Edge 冒烟使用 Windows 已安装的 Microsoft Edge 稳定版。测试范围、数据隔离和未来后端复用约定见 [自动化测试策略](document/TEST_STRATEGY.md)，本轮实测数据与缺陷清单见 [全面测试报告](document/COMPREHENSIVE_TEST_REPORT.md)。
