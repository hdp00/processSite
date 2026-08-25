import assert from "node:assert/strict";
import test from "node:test";

import {
  CreateUserRequest,
  ListDepartmentsQueryParams,
  ListProcessInstancesQueryParams,
  ListUsersQueryParams,
  ProblemCode,
} from "../dist/generated/validators/flowpilot.zod.js";

const baseUser = {
  loginName: "zhangsan",
  name: "张三",
  email: "zhangsan@example.com",
  departmentId: "11111111-1111-4111-8111-111111111111",
  positionId: "22222222-2222-4222-8222-222222222222",
  roleIds: ["33333333-3333-4333-8333-333333333333"],
  status: "enabled",
};

test("CreateUserRequest 区分 password 与 domain 凭据", () => {
  assert.equal(
    CreateUserRequest.safeParse({
      ...baseUser,
      authenticationMode: "password",
      initialPassword: "unit-test-password",
    }).success,
    true,
  );
  assert.equal(
    CreateUserRequest.safeParse({ ...baseUser, authenticationMode: "password" }).success,
    false,
  );
  assert.equal(
    CreateUserRequest.safeParse({ ...baseUser, authenticationMode: "domain" }).success,
    true,
  );
  assert.equal(
    CreateUserRequest.safeParse({
      ...baseUser,
      authenticationMode: "domain",
      initialPassword: "not-allowed",
    }).success,
    false,
  );
});

test("boolean 查询参数仅接受 true/false/1/0 并保留正确语义", () => {
  assert.equal(ListDepartmentsQueryParams.parse({ includeDisabled: "false" }).includeDisabled, false);
  assert.equal(ListDepartmentsQueryParams.parse({ includeDisabled: "0" }).includeDisabled, false);
  assert.equal(ListDepartmentsQueryParams.parse({ includeDisabled: "true" }).includeDisabled, true);
  assert.equal(ListDepartmentsQueryParams.parse({ includeDisabled: "1" }).includeDisabled, true);
  assert.equal(
    ListDepartmentsQueryParams.safeParse({ includeDisabled: "false", unexpected: "field" }).success,
    false,
  );

  for (const invalidValue of ["", "yes", "TRUE", "2"]) {
    assert.equal(
      ListDepartmentsQueryParams.safeParse({ includeDisabled: invalidValue }).success,
      false,
    );
  }

  const usersQuery = ListUsersQueryParams.parse({ page: "2", hasEmail: "false" });
  assert.equal(usersQuery.page, 2);
  assert.equal(usersQuery.hasEmail, false);
  const instanceQueryRange = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };
  assert.equal(
    ListProcessInstancesQueryParams.parse({ ...instanceQueryRange, activeOnly: "1" }).activeOnly,
    true,
  );
  assert.equal(
    ListProcessInstancesQueryParams.parse({ ...instanceQueryRange, q: "false" }).q,
    "false",
  );
});

test("ProblemCode 包含服务端与 mock 已使用的错误码", () => {
  for (const code of [
    "USER_ROLE_REQUIRED",
    "PDF_ATTACHMENT_REQUIRED",
    "INTERNAL_SERVER_ERROR",
  ]) {
    assert.equal(ProblemCode.parse(code), code);
  }
});
