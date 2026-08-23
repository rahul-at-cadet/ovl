// Local dev runs web-office and api-office as separate origins (ports
// 3000/3001), so browser-side calls need an absolute URL. In a Docker/
// nginx deployment they're served under one public origin with nginx
// routing by path, so calls must be relative — an absolute localhost
// URL would send the visitor's own browser looking at their machine,
// not the server. `next build` always forces NODE_ENV=production for
// the client bundle, so this needs no separate build-time config.
export const API_ORIGIN = process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001';
