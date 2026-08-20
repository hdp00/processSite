import { FetchInterceptor } from "@mswjs/interceptors/fetch";
import { XMLHttpRequestInterceptor } from "@mswjs/interceptors/XMLHttpRequest";
import { defineNetwork, InterceptorSource } from "msw/experimental";
import { handlers } from "./handlers";

type NetworkInterceptor = ConstructorParameters<typeof InterceptorSource>[0]["interceptors"][number];

// MSW 2.15's experimental source declares HTTP and WebSocket event maps as a
// union that TypeScript narrows to never. Both interceptors implement the
// runtime Interceptor contract expected by InterceptorSource.
const asNetworkInterceptor = (interceptor: FetchInterceptor | XMLHttpRequestInterceptor) =>
  interceptor as unknown as NetworkInterceptor;

const network = defineNetwork({
  sources: [new InterceptorSource({
    interceptors: [
      asNetworkInterceptor(new XMLHttpRequestInterceptor()),
      asNetworkInterceptor(new FetchInterceptor()),
    ],
  })],
  handlers,
  onUnhandledFrame: "warn",
});

export const startMockApi = async () => {
  await network.enable();
};
