import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FlowPilotConfigModule } from "../../config/config.module.js";
import { DatabaseModule } from "../database.module.js";
import { FlowPilotDataSourceManager } from "../flowpilot-data-source.manager.js";
import { BuiltinSeedService } from "../seed/builtin-seed.service.js";

@Module({ imports: [FlowPilotConfigModule, DatabaseModule] })
class SeedCliModule {}

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "DATABASE_SEED_FAILED";
};

async function seed(): Promise<void> {
  const context = await NestFactory.createApplicationContext(SeedCliModule, {
    logger: ["error", "warn"]
  });
  try {
    const manager = context.get(FlowPilotDataSourceManager);
    await manager.inspectSchemaReadiness();
    const result = await context.get(BuiltinSeedService).run();
    await manager.inspectReadiness();
    process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
  } finally {
    await context.close();
  }
}

try {
  await seed();
} catch (error: unknown) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: errorCode(error) })}\n`);
  process.exitCode = 1;
}
