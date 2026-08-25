# FlowPilot API Contract

This workspace turns `document/flowpilot-rest-api.openapi.yaml` into the shared
TypeScript contract used by the browser and the NestJS API.

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
