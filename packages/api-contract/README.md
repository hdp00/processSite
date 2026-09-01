# FlowPilot API Contract

This workspace turns `document/flowpilot-rest-api.openapi.yaml` into the generated
TypeScript contract used by the browser. The production backend is .NET 10 / ASP.NET
Core 10 and does not consume this TypeScript or Zod package.

From the repository root:

```bash
pnpm contract:lint
pnpm contract:generate
pnpm contract:check
```

Generated sources are committed under `src/generated`. The package exposes:

- `@process-site/api-contract` for DTOs, the Axios client factories, and the
  `flowpilotValidators` namespace.
- `@process-site/api-contract/models` for DTO types.
- `@process-site/api-contract/client` for the Axios client factories.
- `@process-site/api-contract/validators` for Zod request and response schemas.

Do not edit `src/generated` by hand. Change the OpenAPI document and regenerate.
The ASP.NET Core backend implements C# request/response DTOs, DataAnnotations and
domain validation independently, then compares its generated OpenAPI document with
the repository contract through semantic contract tests.

`src/generated` is regenerated and checked in CI from the current OpenAPI document.
The browser uses the ASP.NET Core REST service directly; this package does not
provide a browser-side service implementation or a second data source.
