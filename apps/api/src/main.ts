import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import {
  RequestContextMiddleware,
  type TraceRequest
} from "./common/http/request-context.middleware.js";
import type { AppEnvironment } from "./config/environment.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false
  });
  const config = app.get(ConfigService<AppEnvironment, true>);

  app.useLogger(app.get(Logger));
  const requestContext = new RequestContextMiddleware();
  app.use((request: Request, response: Response, next: NextFunction) => (
    requestContext.use(request as TraceRequest, response, next)
  ));
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser("json", { limit: config.get("HTTP_JSON_LIMIT_BYTES", { infer: true }), strict: true });
  app.useBodyParser("urlencoded", { limit: config.get("HTTP_JSON_LIMIT_BYTES", { infer: true }), extended: false });
  app.set("trust proxy", "loopback");
  app.setGlobalPrefix("api/flowpilot/v1");
  app.enableShutdownHooks();

  await app.listen(
    config.get("APP_PORT", { infer: true }),
    config.get("APP_HOST", { infer: true })
  );
}

await bootstrap();
