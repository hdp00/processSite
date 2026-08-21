import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const APP_BASE_PATH = "/flowpilot";

const redirectAppBase = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
  const requestUrl = request.url ?? "";
  if (requestUrl !== APP_BASE_PATH && !requestUrl.startsWith(`${APP_BASE_PATH}?`)) {
    next();
    return;
  }
  response.statusCode = 308;
  response.setHeader("Location", `${APP_BASE_PATH}/${requestUrl.slice(APP_BASE_PATH.length)}`);
  response.end();
};

const normalizeAppBasePlugin = (): Plugin => ({
  name: "flowpilot-normalize-app-base",
  configureServer(server) {
    server.middlewares.use(redirectAppBase);
  },
  configurePreviewServer(server) {
    server.middlewares.use(redirectAppBase);
  },
});

export default defineConfig({
  // The application is hosted as the /flowpilot IIS application.
  base: `${APP_BASE_PATH}/`,
  plugins: [normalizeAppBasePlugin(), react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 950,
  },
});
