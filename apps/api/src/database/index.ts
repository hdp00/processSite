export { DatabaseModule } from "./database.module.js";
export {
  UNSUPPORTED_LOCALDB_DRIVER,
  UnsupportedLocalDbDriverError,
  assertSupportedMssqlServer,
  createDataSourceOptions,
  type DatabaseEnvironment
} from "./database-options.js";
export { createFlowPilotDataSource } from "./data-source.js";
export * from "./entities/index.js";
export {
  DatabaseReadinessError,
  FlowPilotDataSourceManager,
  type DatabasePlatformSnapshot,
  type DatabaseReadinessSnapshot,
  type DatabaseStructureReadinessSnapshot
} from "./flowpilot-data-source.manager.js";
export {
  TypeOrmPersistenceUnitOfWork,
  type TypeOrmPersistenceTransactionContext
} from "./persistence/typeorm-persistence-unit-of-work.js";
export {
  BootstrapAdminPasswordRequiredError,
  BuiltinSeedConflictError,
  BuiltinSeedService,
  type BuiltinSeedResult
} from "./seed/builtin-seed.service.js";
export {
  BUILTIN_IDS,
  BUILTIN_PERMISSION_SEEDS,
  BUILTIN_SEED_VERSION,
  type BuiltinPermissionSeed
} from "./seed/builtin-catalog.js";
