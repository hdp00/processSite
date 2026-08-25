import type {
  AuthenticationMode,
  DepartmentRef,
  PositionRef,
  SessionDto,
  UserDto,
  UserRef,
} from "@process-site/api-contract/models";

export type {
  AuthenticationMode,
  DepartmentRef as DepartmentReferenceDto,
  PositionRef as PositionReferenceDto,
  SessionDto,
  UserDto,
  UserRef as UserReferenceDto,
};

export interface AuthRoleRecord {
  id: string;
  name: string;
  enabled: boolean;
  permissions: string[];
}

export interface AuthUserRecord {
  id: string;
  revision: number;
  loginName: string;
  normalizedLoginName: string;
  name: string;
  email: string;
  authenticationMode: AuthenticationMode;
  passwordHash?: string;
  enabled: boolean;
  builtInSuperAdmin: boolean;
  department: DepartmentRef;
  position: PositionRef;
  roles: AuthRoleRecord[];
  allPermissionCodes?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredSessionRecord {
  id: string;
  tokenHash: string;
  operatorUserId: string;
  effectiveUserId: string;
  createdAt: Date;
  lastAccessedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt?: Date;
  revokedReason?: string;
}

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  operatorUserId: string;
  roleIds: string[];
  permissions: string[];
  superAdmin: boolean;
  operatorSuperAdmin: boolean;
  expiresAt: Date;
}

export interface AuthenticatedSession {
  principal: SessionPrincipal;
  dto: SessionDto;
}

export interface LoginResult extends AuthenticatedSession {
  sessionToken: string;
}
