// Local dev runs web-vessel and api-vessel as separate origins (ports
// 3002/3003), so browser-side calls need an absolute URL. In the deployed
// stack they're served under one public origin with nginx routing by path
// (deploy/nginx/nginx.conf), so calls must be relative — an absolute localhost
// URL would send the visitor's own browser looking at their machine,
// not the server. `next build` always forces NODE_ENV=production for
// the client bundle, so this needs no separate build-time config.
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3003');

/**
 * Base for api-vessel's REST controllers, which all sit under /api
 * (api-vessel/src/main.ts calls setGlobalPrefix).
 *
 * Use this for plain `fetch` calls rather than building paths on
 * API_ORIGIN. Without the prefix a single-origin deployment cannot tell
 * this app's /reports page from api-vessel's /reports controller, and the
 * reverse proxy is left naming endpoints one at a time — which is how the
 * office side ended up with an unroutable /users/me/password.
 *
 * tRPC keeps using API_ORIGIN: it is middleware at /trpc, not a
 * controller, so the prefix does not apply to it.
 */
export const API_BASE = `${API_ORIGIN}/api`;
