import { create } from "zustand";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import type { AuthSession, ImpersonationContext } from "../api/contracts";

export type PersonaId = string;
export const SUPER_ADMIN_PERSONA_ID: PersonaId = "superadmin";
export const isSuperAdminPersona = (personaId: PersonaId) => personaId === SUPER_ADMIN_PERSONA_ID;

interface ApplicationSessionState {
  authenticated: boolean;
  personaId: PersonaId;
  operatorUserId: PersonaId;
  sessionPermissions: string[];
  sessionSuperAdmin: boolean;
  operatorSuperAdmin: boolean;
  impersonation?: ImpersonationContext;
  instances: ProcessInstance[];
  tasks: WorkflowTask[];
  applyAuthSession: (session: AuthSession) => void;
  logout: () => void;
}

const anonymousState = {
  authenticated: false,
  personaId: "",
  operatorUserId: "",
  sessionPermissions: [] as string[],
  sessionSuperAdmin: false,
  operatorSuperAdmin: false,
  impersonation: undefined,
  instances: [] as ProcessInstance[],
  tasks: [] as WorkflowTask[],
};

export const usePrototypeStore = create<ApplicationSessionState>()((set) => ({
  ...anonymousState,
  applyAuthSession: (session) => set({
    authenticated: true,
    personaId: session.user.id,
    operatorUserId: session.operatorUser?.id ?? session.user.id,
    sessionPermissions: [...(session.permissions ?? [])],
    sessionSuperAdmin: session.superAdmin ?? false,
    operatorSuperAdmin: session.operatorSuperAdmin ?? false,
    impersonation: session.impersonation,
  }),
  logout: () => set(anonymousState),
}));

export const isSessionSuperAdmin = (personaId?: string) => {
  const session = usePrototypeStore.getState();
  return session.authenticated
    && session.sessionSuperAdmin
    && (!personaId || personaId === session.personaId);
};

export const canUserTransferFreeFlow = (instance: ProcessInstance, userId: string) =>
  instance.workflowType === "free"
  && instance.status === "进行中"
  && userId === usePrototypeStore.getState().personaId
  && Boolean(instance.canTransferFree);

export const canUserReplyFreeFlow = (
  instance: ProcessInstance,
  userId: string,
  isParticipant: boolean,
) => instance.workflowType === "free"
  && instance.status === "进行中"
  && userId === usePrototypeStore.getState().personaId
  && (isParticipant || Boolean(instance.canTransferFree));
