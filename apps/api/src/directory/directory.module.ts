import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/index.js";
import { CatalogController } from "./catalog.controller.js";
import { DIRECTORY_PERSISTENCE } from "./directory.persistence.js";
import { DirectoryService } from "./directory.service.js";
import { TypeOrmDirectoryPersistence } from "./typeorm-directory.persistence.js";

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [CatalogController],
  providers: [
    DirectoryService,
    TypeOrmDirectoryPersistence,
    { provide: DIRECTORY_PERSISTENCE, useExisting: TypeOrmDirectoryPersistence },
  ],
})
export class DirectoryModule {}
