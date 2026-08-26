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

Current transition note: the documentation-only 1.5.0 contract update introduces
the task-center discriminator, `active` attachment status and latest-only free reply
shape. `src/generated` and the browser Mock remain on the previous compatibility
shape until the code migration task runs `pnpm contract:generate` and updates the
adapters/tests together; do not treat those generated files as the current contract.
