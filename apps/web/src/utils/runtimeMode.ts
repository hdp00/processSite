export const isRemoteApiMode = import.meta.env.VITE_API_MODE === "remote";

export const isBrowserMockMode = import.meta.env.VITE_API_MODE === "mock"
  || (import.meta.env.DEV && !isRemoteApiMode);
