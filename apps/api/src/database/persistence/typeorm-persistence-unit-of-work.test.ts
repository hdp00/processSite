import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeOrmPersistenceUnitOfWork } from "./typeorm-persistence-unit-of-work.js";

const queryRunner = () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  startTransaction: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
  rollbackTransaction: vi.fn().mockResolvedValue(undefined),
  release: vi.fn().mockResolvedValue(undefined),
  manager: { marker: "transaction-manager" },
  isTransactionActive: true,
  isReleased: false
});

describe("TypeOrmPersistenceUnitOfWork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits and releases a transaction-specific QueryRunner", async () => {
    const runner = queryRunner();
    const dataSource = { createQueryRunner: vi.fn(() => runner) };
    const manager = { ensureInitialized: vi.fn().mockResolvedValue(dataSource) };
    const unitOfWork = new TypeOrmPersistenceUnitOfWork(manager as never);

    await expect(unitOfWork.execute(async (context) => {
      expect(context.manager).toBe(runner.manager);
      expect(context.queryRunner).toBe(runner);
      expect(context.transactionId).toMatch(/^[0-9a-f-]{36}$/);
      return "committed";
    }, { isolationLevel: "SERIALIZABLE" })).resolves.toBe("committed");

    expect(runner.startTransaction).toHaveBeenCalledWith("SERIALIZABLE");
    expect(runner.commitTransaction).toHaveBeenCalledOnce();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases when the operation fails", async () => {
    const runner = queryRunner();
    const failure = new Error("operation failed");
    const unitOfWork = new TypeOrmPersistenceUnitOfWork({
      ensureInitialized: vi.fn().mockResolvedValue({ createQueryRunner: () => runner })
    } as never);

    await expect(unitOfWork.execute(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledOnce();
    expect(runner.release).toHaveBeenCalledOnce();
  });

  it("does not report a committed operation as failed when release fails", async () => {
    const runner = queryRunner();
    runner.release.mockRejectedValue(new Error("release failed"));
    const logger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const unitOfWork = new TypeOrmPersistenceUnitOfWork({
      ensureInitialized: vi.fn().mockResolvedValue({ createQueryRunner: () => runner })
    } as never);

    await expect(unitOfWork.execute(() => Promise.resolve("committed"))).resolves.toBe("committed");
    expect(runner.commitTransaction).toHaveBeenCalledOnce();
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("事务已经提交"));
  });

  it("preserves the original operation error when release also fails", async () => {
    const runner = queryRunner();
    runner.release.mockRejectedValue(new Error("release failed"));
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const failure = new Error("operation failed");
    const unitOfWork = new TypeOrmPersistenceUnitOfWork({
      ensureInitialized: vi.fn().mockResolvedValue({ createQueryRunner: () => runner })
    } as never);

    await expect(unitOfWork.execute(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});
