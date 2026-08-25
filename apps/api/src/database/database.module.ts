import { Module } from "@nestjs/common";
import { PERSISTENCE_UNIT_OF_WORK } from "../domain/persistence/index.js";
import { FlowPilotDataSourceManager } from "./flowpilot-data-source.manager.js";
import { TypeOrmPersistenceUnitOfWork } from "./persistence/typeorm-persistence-unit-of-work.js";
import { BuiltinSeedService } from "./seed/builtin-seed.service.js";

@Module({
  providers: [
    FlowPilotDataSourceManager,
    TypeOrmPersistenceUnitOfWork,
    BuiltinSeedService,
    {
      provide: PERSISTENCE_UNIT_OF_WORK,
      useExisting: TypeOrmPersistenceUnitOfWork
    }
  ],
  exports: [
    FlowPilotDataSourceManager,
    TypeOrmPersistenceUnitOfWork,
    BuiltinSeedService,
    PERSISTENCE_UNIT_OF_WORK
  ]
})
export class DatabaseModule {}
