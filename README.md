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
