// Local dev runs web-office and api-office as separate origins (ports
// 3000/3001), so browser-side calls need an absolute URL. In the deployed
// stack they're served under one public origin with nginx routing by path
// (deploy/nginx/nginx.conf), so calls must be relative — an absolute
// localhost URL would send the visitor's own browser looking at their
// machine, not the server. `next build` always forces NODE_ENV=production
// for the client bundle, so this needs no separate build-time config.
export const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001');

/**
 * Base for api-office's REST controllers, which all sit under /api
 * (api-office/src/main.ts calls setGlobalPrefix).
 *
 * Use this for plain `fetch` calls rather than building paths on
 * API_ORIGIN directly. The prefix exists because web-office and
 * api-office share one public origin and both claim /users, /reports and
 * /attachments; routing them apart requires the API side to be namespaced.
 * Anything written against the bare origin lands on a Next.js page
 * instead — which is how a PATCH to /users/me/password came back as the
 * 404 page rather than reaching the API at all.
 *
 * tRPC keeps using API_ORIGIN: it is mounted as middleware at /trpc, not
 * as a controller, so the prefix does not apply to it.
 */
export const API_BASE = `${API_ORIGIN}/api`;
