import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

export const startMockApi = () => worker.start({
  serviceWorker: { url: "/mockServiceWorker.js" },
  onUnhandledRequest(request, print) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) print.warning();
  },
});
