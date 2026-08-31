import { createContext, useContext, type ReactNode } from "react";
import type { ProcessLaunchConfig } from "../api/contracts";

const ProcessLaunchConfigContext = createContext<ProcessLaunchConfig | undefined>(undefined);

export function ProcessLaunchConfigProvider({
  value,
  children,
}: {
  value?: ProcessLaunchConfig;
  children: ReactNode;
}) {
  return <ProcessLaunchConfigContext.Provider value={value}>{children}</ProcessLaunchConfigContext.Provider>;
}

export const useProcessLaunchConfig = () => useContext(ProcessLaunchConfigContext);
