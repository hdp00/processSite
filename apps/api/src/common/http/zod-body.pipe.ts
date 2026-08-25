import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ProblemException } from "./problem-details.js";

export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new ProblemException({
      status: 400,
      code: "BAD_REQUEST",
      title: "请求参数不正确",
      detail: "请检查提交的字段后重试。",
      errors: result.error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join("/")}`,
        code: issue.code,
        message: issue.message
      }))
    });
  }
}
