import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FlowPilotConfigModule } from "../../config/config.module.js";
import { DatabaseModule } from "../database.module.js";
import { FlowPilotDataSourceManager } from "../flowpilot-data-source.manager.js";

@Module({ imports: [FlowPilotConfigModule, DatabaseModule] })
class MigrationCliModule {}

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "DATABASE_MIGRATION_FAILED";
};

async function migrate(): Promise<void> {
  const context = await NestFactory.createApplicationContext(MigrationCliModule, {
    logger: ["error", "warn"]
  });
  try {
    const manager = context.get(FlowPilotDataSourceManager);
    await manager.inspectPlatform();
    const dataSource = await manager.ensureInitialized();
    const migrations = await dataSource.runMigrations({ transaction: "all" });
    await manager.inspectSchemaReadiness();
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      executed: migrations.map((migration) => migration.name)
    })}\n`);
  } finally {
    await context.close();
  }
}

try {
  await migrate();
} catch (error: unknown) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: errorCode(error) })}\n`);
  process.exitCode = 1;
}
