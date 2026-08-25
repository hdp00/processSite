import { defineConfig } from "orval";

const openApiDocument = "../../document/flowpilot-rest-api.openapi.yaml";
const booleanQueryPreprocessor = {
  path: "./src/query-boolean-preprocessor.ts",
  name: "normalizeFlowPilotQueryBooleans",
  extension: ".js",
} as const;

export default defineConfig({
  flowpilotClient: {
    input: {
      target: openApiDocument,
    },
    output: {
      baseUrl: "/api/flowpilot/v1",
      clean: true,
      client: "axios",
      headers: true,
      mode: "single",
      target: "./src/generated/client/flowpilot.ts",
      tsconfig: "./tsconfig.json",
      override: {
        requestOptions: true,
        urlEncodeParameters: true,
      },
    },
  },
  flowpilotValidators: {
    input: {
      target: openApiDocument,
    },
    output: {
      clean: true,
      client: "zod",
      headers: true,
      mode: "single",
      target: "./src/generated/validators/flowpilot.zod.ts",
      tsconfig: "./tsconfig.json",
      override: {
        operations: {
          listDepartments: {
            zod: {
              coerce: { query: ["number"] },
              preprocess: { query: booleanQueryPreprocessor },
              strict: { query: true },
            },
          },
          listProcessInstances: {
            zod: {
              coerce: { query: ["number"] },
              preprocess: { query: booleanQueryPreprocessor },
              strict: { query: true },
            },
          },
          listUsers: {
            zod: {
              coerce: { query: ["number"] },
              preprocess: { query: booleanQueryPreprocessor },
              strict: { query: true },
            },
          },
        },
        zod: {
          version: 4,
          variant: "classic",
          strict: {
            body: true,
            header: true,
            param: true,
            query: true,
            response: true,
          },
          coerce: {
            query: ["number"],
          },
          generate: {
            body: true,
            header: true,
            param: true,
            query: true,
            response: true,
          },
          generateEachHttpStatus: true,
          generateDiscriminatedUnion: true,
          generateReusableSchemas: true,
        },
      },
    },
  },
});
