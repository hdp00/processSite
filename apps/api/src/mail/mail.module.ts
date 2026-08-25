import { type DynamicModule, type FactoryProvider, Module, type ModuleMetadata } from "@nestjs/common";
import {
  SMTP_MAIL_CONFIGURATION,
  SMTP_TRANSPORT_FACTORY,
  type SmtpMailConfiguration,
} from "./mail.types.js";
import { NodemailerSmtpTransportFactory } from "./nodemailer-smtp-transport.factory.js";
import { SmtpMailGateway } from "./smtp-mail.gateway.js";

export interface MailModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryProvider<SmtpMailConfiguration>["inject"];
  useFactory: FactoryProvider<SmtpMailConfiguration>["useFactory"];
}

@Module({})
export class MailModule {
  static registerAsync(options: MailModuleAsyncOptions): DynamicModule {
    return {
      module: MailModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: SMTP_MAIL_CONFIGURATION,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        {
          provide: SMTP_TRANSPORT_FACTORY,
          useClass: NodemailerSmtpTransportFactory,
        },
        SmtpMailGateway,
      ],
      exports: [SmtpMailGateway],
    };
  }
}
