import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolveEnvironmentFilePaths, validateEnvironment } from "./environment.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: false,
      envFilePath: resolveEnvironmentFilePaths(),
      validate: validateEnvironment
    })
  ]
})
export class FlowPilotConfigModule {}
