import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import {
  DepartmentEntity,
  PermissionEntity,
  PositionEntity,
  RoleEntity,
  RolePermissionEntity,
  SystemStateEntity,
  UserEntity,
  UserRoleEntity
} from "../entities/index.js";
import {
  BootstrapAdminPasswordRequiredError,
  BuiltinSeedService,
  type BuiltinSeedResult
} from "./builtin-seed.service.js";
import { BUILTIN_IDS, BUILTIN_PERMISSION_SEEDS } from "./builtin-catalog.js";

const result: BuiltinSeedResult = {
  seedVersion: "test",
  createdDepartment: false,
  createdPosition: false,
  createdManagerPosition: false,
  createdEmployeePosition: false,
  createdRole: false,
  createdUser: false,
  createdPermissions: 0,
  updatedPermissions: 0,
  removedPermissions: 0,
  removedRolePermissions: 0,
  createdRolePermissions: 0,
  createdUserRole: false
};

describe("BuiltinSeedService", () => {
  it("requires the external bootstrap password only when superadmin is absent", async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const dataSources = {
      ensureInitialized: vi.fn().mockResolvedValue({
        getRepository: () => ({ findOne })
      })
    };
    const unitOfWork = { execute: vi.fn() };
    const service = new BuiltinSeedService(
      new ConfigService({}) as ConfigService<AppEnvironment, true>,
      dataSources as never,
      unitOfWork as never
    );

    await expect(service.run()).rejects.toBeInstanceOf(BootstrapAdminPasswordRequiredError);
    expect(unitOfWork.execute).not.toHaveBeenCalled();
  });

  it("does not require or rewrite a bootstrap password after initialization", async () => {
    const unitOfWork = { execute: vi.fn().mockResolvedValue(result) };
    const service = new BuiltinSeedService(
      new ConfigService({}) as ConfigService<AppEnvironment, true>,
      {
        ensureInitialized: vi.fn().mockResolvedValue({
          getRepository: () => ({ findOne: vi.fn().mockResolvedValue({ id: "existing" }) })
        })
      } as never,
      unitOfWork as never
    );

    await expect(service.run()).resolves.toBe(result);
    expect(unitOfWork.execute).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "SERIALIZABLE"
    });
  });

  it("keeps the built-in permission catalog stable and duplicate-free", () => {
    const codes = BUILTIN_PERMISSION_SEEDS.map((permission) => permission.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("config-definition:查看");
    expect(codes).toContain("system-monitor:查看");
    expect(codes).toContain("org-group:删除");
    expect(BUILTIN_PERMISSION_SEEDS.find((permission) => permission.code === "work-launch:查看"))
      .toMatchObject({ category: "员工工作区", kind: "page" });
    expect(BUILTIN_PERMISSION_SEEDS.find((permission) => permission.code === "work-launch:发起"))
      .toMatchObject({ category: "员工工作区", kind: "action" });
    expect(BUILTIN_PERMISSION_SEEDS.find((permission) => permission.code === "config-form:编辑"))
      .toMatchObject({ kind: "page" });
  });

  it("transactionally creates the system, manager and employee positions", async () => {
    type Row = Record<string, unknown>;
    const rowsByEntity = new Map<Function, Row[]>();
    const entities = [
      DepartmentEntity,
      PositionEntity,
      RoleEntity,
      PermissionEntity,
      UserEntity,
      UserRoleEntity,
      RolePermissionEntity,
      SystemStateEntity
    ];
    entities.forEach((entity) => rowsByEntity.set(entity, []));
    const repository = (entity: Function) => {
      const rows = rowsByEntity.get(entity) ?? [];
      const matches = (row: Row, where: Row) => Object.entries(where).every(
        ([key, expected]) => row[key] === expected
      );
      return {
        find: vi.fn(async (options?: { where?: Row }) => (
          options?.where ? rows.filter((row) => matches(row, options.where ?? {})) : [...rows]
        )),
        findOne: vi.fn(async (options: { where: Row }) => (
          rows.find((row) => matches(row, options.where)) ?? null
        )),
        create: vi.fn((value: Row) => ({ ...value })),
        save: vi.fn(async (value: Row) => {
          rows.push(value);
          return value;
        }),
        update: vi.fn(async (where: Row, value: Row) => {
          const row = rows.find((candidate) => matches(candidate, where));
          if (row) Object.assign(row, value);
          return { affected: row ? 1 : 0 };
        }),
        delete: vi.fn(async (where: Row) => {
          let affected = 0;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (row && matches(row, where)) {
              rows.splice(index, 1);
              affected += 1;
            }
          }
          return { affected };
        })
      };
    };
    const repositories = new Map<Function, ReturnType<typeof repository>>(
      entities.map((entity) => [entity, repository(entity)])
    );
    const manager = { getRepository: (entity: Function) => repositories.get(entity) };
    const unitOfWork = {
      execute: vi.fn(async (operation: (context: { manager: unknown }) => Promise<BuiltinSeedResult>) => (
        operation({ manager })
      ))
    };
    const initialConfig = new ConfigService({
      FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD: "unit-test-only"
    }) as ConfigService<AppEnvironment, true>;
    const service = new BuiltinSeedService(
      initialConfig,
      {
        ensureInitialized: vi.fn().mockResolvedValue({
          getRepository: () => repositories.get(UserEntity)
        })
      } as never,
      unitOfWork as never
    );

    await expect(service.run(new Date("2026-08-25T00:00:00.000Z"))).resolves.toMatchObject({
      createdPosition: true,
      createdManagerPosition: true,
      createdEmployeePosition: true
    });
    expect(rowsByEntity.get(PositionEntity)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: BUILTIN_IDS.systemPosition, name: "系统内置" }),
      expect.objectContaining({ id: BUILTIN_IDS.managerPosition, name: "经理" }),
      expect.objectContaining({ id: BUILTIN_IDS.employeePosition, name: "员工" })
    ]));
    const initialPasswordHash = rowsByEntity.get(UserEntity)?.[0]?.passwordHash;
    const permissionRows = rowsByEntity.get(PermissionEntity) ?? [];
    const driftedPermission = permissionRows.find((row) => row.code === "work-launch:查看");
    if (!driftedPermission) throw new Error("missing seeded permission");
    driftedPermission.name = "漂移名称";
    driftedPermission.sortOrder = -1;
    driftedPermission.isBuiltin = false;
    permissionRows.push({
      code: "legacy-builtin:查看",
      resource: "legacy-builtin",
      action: "查看",
      name: "已废弃内置权限",
      sortOrder: 9_999,
      isBuiltin: true
    }, {
      code: "custom-extension:execute",
      resource: "custom-extension",
      action: "execute",
      name: "非内置扩展权限",
      sortOrder: 10_000,
      isBuiltin: false
    });
    (rowsByEntity.get(RolePermissionEntity) ?? []).push({
      roleId: BUILTIN_IDS.superAdminRole,
      permissionCode: "legacy-builtin:查看",
      grantedBy: BUILTIN_IDS.superAdminUser,
      grantedAt: new Date("2026-08-25T00:00:00.000Z")
    });
    const repeatedConfig = new ConfigService({
      FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD: "must-not-overwrite"
    }) as ConfigService<AppEnvironment, true>;
    const repeated = new BuiltinSeedService(
      repeatedConfig,
      {
        ensureInitialized: vi.fn().mockResolvedValue({
          getRepository: () => repositories.get(UserEntity)
        })
      } as never,
      unitOfWork as never
    );
    await expect(repeated.run(new Date("2026-08-25T01:00:00.000Z"))).resolves.toMatchObject({
      createdPosition: false,
      createdManagerPosition: false,
      createdEmployeePosition: false,
      createdUser: false,
      updatedPermissions: 1,
      removedPermissions: 1,
      removedRolePermissions: 1
    });
    expect(rowsByEntity.get(UserEntity)?.[0]?.passwordHash).toBe(initialPasswordHash);
    expect(permissionRows.find((row) => row.code === "work-launch:查看")).toMatchObject({
      name: "流程发起 - 查看",
      sortOrder: 101,
      isBuiltin: true
    });
    expect(permissionRows.some((row) => row.code === "legacy-builtin:查看")).toBe(false);
    expect(permissionRows.some((row) => row.code === "custom-extension:execute")).toBe(true);
  });
});
