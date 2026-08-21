# FlowPilot 流程审核平台原型

前端开发环境默认启用浏览器内 Mock REST API，无需启动后端即可演示登录、流程定义、实例、任务、附件、邮件 Outbox、审计和 Excel 导出。

- [Mock REST API 使用说明](document/MOCK_REST_API.md)
- [IIS 部署说明](document/IIS_DEPLOYMENT.md)
- [OpenAPI 3.1 契约](document/flowpilot-rest-api.openapi.yaml)

```bash
pnpm install
pnpm dev
```

构建命令按数据来源严格分开：

```bash
# 正式包：请求同源 /api/v1，由 IIS 代理到后端
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
