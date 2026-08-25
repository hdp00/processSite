import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EntityManager, QueryRunner } from "typeorm";
import type {
  PersistenceIsolationLevel,
  PersistenceTransactionContext,
  PersistenceTransactionOptions,
  PersistenceUnitOfWork
} from "../../domain/persistence/index.js";
import { FlowPilotDataSourceManager } from "../flowpilot-data-source.manager.js";

export interface TypeOrmPersistenceTransactionContext extends PersistenceTransactionContext {
  readonly manager: EntityManager;
  readonly queryRunner: QueryRunner;
}

@Injectable()
export class TypeOrmPersistenceUnitOfWork
implements PersistenceUnitOfWork<TypeOrmPersistenceTransactionContext> {
  private readonly logger = new Logger(TypeOrmPersistenceUnitOfWork.name);

  constructor(private readonly dataSourceManager: FlowPilotDataSourceManager) {}

  async execute<T>(
    operation: (context: TypeOrmPersistenceTransactionContext) => Promise<T>,
    options: PersistenceTransactionOptions = {}
  ): Promise<T> {
    const isolationLevel: PersistenceIsolationLevel = options.isolationLevel ?? "READ COMMITTED";
    const dataSource = await this.dataSourceManager.ensureInitialized();
    const queryRunner = dataSource.createQueryRunner();
    let operationError: unknown;
    let committed = false;

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction(isolationLevel);
      const result = await operation({
        transactionId: randomUUID(),
        isolationLevel,
        manager: queryRunner.manager,
        queryRunner
      });
      await queryRunner.commitTransaction();
      committed = true;
      return result;
    } catch (error: unknown) {
      operationError = error;
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction();
        } catch (rollbackError: unknown) {
          throw new AggregateError([error, rollbackError], "事务失败且回滚未成功");
        }
      }
      throw error;
    } finally {
      if (!queryRunner.isReleased) {
        try {
          await queryRunner.release();
        } catch (releaseError: unknown) {
          const errorName = releaseError instanceof Error ? releaseError.name : "UnknownError";
          if (committed) {
            this.logger.error(`事务已经提交，但 QueryRunner 释放失败（${errorName}）；不改变已提交的调用结果`);
          } else if (operationError !== undefined) {
            this.logger.error(`事务失败后 QueryRunner 释放失败（${errorName}）；保留原始事务错误`);
          } else {
            throw releaseError;
          }
        }
      }
    }
  }
}
