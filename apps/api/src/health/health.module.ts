import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DatabaseModule } from "../database/index.js";
import { HealthController } from "./health.controller.js";
import { ReadinessService } from "./readiness.service.js";

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [HealthController],
  providers: [ReadinessService]
})
export class HealthModule {}
