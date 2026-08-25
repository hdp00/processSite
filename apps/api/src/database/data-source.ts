import { DataSource } from "typeorm";
import { createDataSourceOptions, type DatabaseEnvironment } from "./database-options.js";

/** Creates an uninitialized DataSource for controlled CLI and test use. */
export function createFlowPilotDataSource(environment: DatabaseEnvironment): DataSource {
  return new DataSource(createDataSourceOptions(environment));
}
