const STATUS_LIGHTS_PATH = '/api/detector-status-lights';
const LIVE_STATUS_LIGHTS_PATH = '/api/detector-status-lights/live';

function remapStatusLightsRequest(input: RequestInfo | URL): RequestInfo | URL {
  try {
    if (typeof input === 'string') {
      const url = new URL(input, window.location.href);
      if (url.pathname !== STATUS_LIGHTS_PATH) return input;
      url.pathname = LIVE_STATUS_LIGHTS_PATH;
      return url.toString();
    }

    if (input instanceof URL) {
      if (input.pathname !== STATUS_LIGHTS_PATH) return input;
      const url = new URL(input.toString());
      url.pathname = LIVE_STATUS_LIGHTS_PATH;
      return url;
    }

    if (input instanceof Request) {
      const url = new URL(input.url);
      if (url.pathname !== STATUS_LIGHTS_PATH) return input;
      url.pathname = LIVE_STATUS_LIGHTS_PATH;
      return new Request(url.toString(), input);
    }
  } catch {
    // Keep the original fetch semantics for malformed or non-URL inputs.
  }
  return input;
}

if (
  typeof window !== 'undefined'
  && typeof window.fetch === 'function'
  && !(window as Window & { __wutosStatusLightFetchPatched?: boolean }).__wutosStatusLightFetchPatched
) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return nativeFetch(remapStatusLightsRequest(input), init);
  }) as typeof window.fetch;
  (window as Window & { __wutosStatusLightFetchPatched?: boolean }).__wutosStatusLightFetchPatched = true;
}

// Relay lamps use the live physical-DIO endpoint and are not latched. The companion
// display runtime keeps user-facing failure reasons concise and Chinese-only.
void import('./detector-status-lights-runtime');
void import('./detection-reason-cn-runtime');
