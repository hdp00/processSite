import {
  IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
  IDENTITY_AND_SESSION_MIGRATION_ID,
  IDENTITY_AND_SESSION_MIGRATION_NAME,
  IdentityAndSessionFoundation1787616000000
} from "./1787616000000-identity-and-session-foundation.js";

export interface ExpectedSchemaMigration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
}

export const FLOWPILOT_MIGRATIONS = [
  IdentityAndSessionFoundation1787616000000
] as const;

export const EXPECTED_SCHEMA_MIGRATIONS: readonly ExpectedSchemaMigration[] = [
  {
    id: IDENTITY_AND_SESSION_MIGRATION_ID,
    name: IDENTITY_AND_SESSION_MIGRATION_NAME,
    checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM
  }
];

export {
  IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
  IDENTITY_AND_SESSION_MIGRATION_ID,
  IDENTITY_AND_SESSION_MIGRATION_NAME,
  IdentityAndSessionFoundation1787616000000
} from "./1787616000000-identity-and-session-foundation.js";
