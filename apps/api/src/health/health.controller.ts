import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard, type SessionRequest } from "../auth/session.guard.js";
import { ProblemException } from "../common/http/problem-details.js";
import { ReadinessService, type OperationalHealthDto, type ReadinessDto } from "./readiness.service.js";

export interface LivenessDto {
  status: "ok";
  checkedAt: string;
}

@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  getLiveness(): LivenessDto {
    return {
      status: "ok",
      checkedAt: new Date().toISOString()
    };
  }


  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessDto> {
    const result = await this.readiness.getReadiness();
    if (result.status === "unavailable") response.status(503);
    return result;
  }

  @Get("details")
  @UseGuards(SessionGuard)
  getOperationalHealthDetails(@Req() request: SessionRequest): Promise<OperationalHealthDto> {
    const principal = request.flowPilotSession?.principal;
    if (!principal || (!principal.superAdmin && !principal.permissions.includes("system-monitor:查看"))) {
      throw new ProblemException({
        status: 403,
        code: "PERMISSION_DENIED",
        title: "没有查看权限",
        detail: "当前账号不能查看系统运维状态。"
      });
    }
    return this.readiness.getOperationalDetails();
  }
}
