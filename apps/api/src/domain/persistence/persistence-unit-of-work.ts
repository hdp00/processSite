export const PERSISTENCE_UNIT_OF_WORK = Symbol("PERSISTENCE_UNIT_OF_WORK");

export type PersistenceIsolationLevel =
  | "READ UNCOMMITTED"
  | "READ COMMITTED"
  | "REPEATABLE READ"
  | "SERIALIZABLE";

export interface PersistenceTransactionContext {
  readonly transactionId: string;
  readonly isolationLevel: PersistenceIsolationLevel;
}

export interface PersistenceTransactionOptions {
  readonly isolationLevel?: PersistenceIsolationLevel;
}

/**
 * Application services depend on this abstraction rather than TypeORM.
 * Infrastructure repositories may narrow the supplied context to their
 * transaction-specific implementation, but domain code must not import it.
 */
export interface PersistenceUnitOfWork<
  TContext extends PersistenceTransactionContext = PersistenceTransactionContext
> {
  execute<T>(
    operation: (context: TContext) => Promise<T>,
    options?: PersistenceTransactionOptions
  ): Promise<T>;
}
