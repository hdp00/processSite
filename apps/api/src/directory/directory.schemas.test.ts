import { describe, expect, it } from "vitest";
import { departmentListQuerySchema, roleListQuerySchema } from "./directory.schemas.js";

describe("directory query schemas", () => {
  it("uses the generated contract to coerce bounded paging values", () => {
    expect(roleListQuerySchema.parse({ page: "2", pageSize: "100", q: "审核" })).toEqual({
      page: 2,
      pageSize: 100,
      q: "审核",
    });
    expect(roleListQuerySchema.safeParse({ page: "0", pageSize: "201" }).success).toBe(false);
  });

  it("parses false explicitly instead of treating every non-empty string as true", () => {
    expect(departmentListQuerySchema.parse({ includeDisabled: "false" })).toEqual({ includeDisabled: false });
    expect(departmentListQuerySchema.parse({ includeDisabled: "1" })).toEqual({ includeDisabled: true });
  });
});
