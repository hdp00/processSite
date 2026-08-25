import { describe, expect, it, vi } from "vitest";
import { ProblemException } from "../common/http/problem-details.js";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("returns the anonymous liveness contract without probing dependencies", () => {
    const result = new HealthController({} as never).getLiveness();

    expect(result.status).toBe("ok");
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  it("sets HTTP 503 when readiness checks fail", async () => {
    const status = vi.fn();
    const controller = new HealthController({
      getReadiness: vi.fn().mockResolvedValue({
        status: "unavailable",
        checkedAt: "2026-08-25T00:00:00.000Z",
        version: "0.1.0",
        code: "DATABASE_UNAVAILABLE"
      })
    } as never);

    await expect(controller.getReadiness({ status } as never)).resolves.toMatchObject({
      status: "unavailable",
      code: "DATABASE_UNAVAILABLE"
    });
    expect(status).toHaveBeenCalledWith(503);
  });

  it("protects operational details with the system monitor permission", async () => {
    const getOperationalDetails = vi.fn().mockResolvedValue({ status: "ok", checks: [] });
    const controller = new HealthController({ getOperationalDetails } as never);

    expect(() => controller.getOperationalHealthDetails({} as never)).toThrow(ProblemException);
    await expect(controller.getOperationalHealthDetails({
      flowPilotSession: {
        principal: {
          superAdmin: false,
          permissions: ["system-monitor:查看"]
        }
      }
    } as never)).resolves.toMatchObject({ status: "ok" });
  });
});
