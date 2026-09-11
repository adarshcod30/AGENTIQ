/**
 * Route extraction for Next.js. Filesystem-convention, not AST: in Next the URL
 * is the file path, so discovery is a mapping from path to route, plus reading
 * the App Router handler files to see which HTTP methods they export.
 *
 * Two conventions, both handled:
 *   Pages Router API : pages/api/users/[id].ts        -> ALL  /api/users/:id
 *                      pages/api/posts/[...slug].ts    -> ALL  /api/posts/*
 *   App Router       : app/users/[id]/route.ts        -> methods from exports
 *                      app/(admin)/stats/route.ts      -> /stats   (route group dropped)
 *
 * Pages API is a single default-export handler that serves every method, so the
 * method is reported as ALL. App Router route handlers export one function per
 * method (GET, POST, ...), so those are read from the file.
 */

const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PAGES_API = /(?:^|\/)(?:src\/)?pages\/api\/(.+)\.(?:js|jsx|ts|tsx)$/;
const APP_ROUTE = /(?:^|\/)(?:src\/)?app\/(.*)route\.(?:js|jsx|ts|tsx)$/;

/** A file-path segment to a URL segment: [id] -> :id, [...slug]/[[...slug]] -> *. */
function segment(seg) {
  if (/^\[\[?\.\.\.[^\]]+\]?\]$/.test(seg)) return '*'; // catch-all / optional catch-all
  const m = /^\[([^\]]+)\]$/.exec(seg);
  if (m) return `:${m[1]}`;
  return seg;
}

/** pages/api/users/[id].ts -> /api/users/:id  (index files map to the directory). */
function pagesApiPath(inner) {
  const parts = inner.split('/').filter(Boolean);
  if (parts[parts.length - 1] === 'index') parts.pop();
  const mapped = parts.map(segment).filter(Boolean);
  return `/api${mapped.length ? `/${mapped.join('/')}` : ''}`;
}

/** app/(admin)/users/[id]/route.ts -> /users/:id  (route groups "(x)" dropped). */
function appRoutePath(inner) {
  const parts = inner.split('/').filter(Boolean)
    .filter((s) => !/^\(.*\)$/.test(s)) // drop route groups (admin)
    .map(segment);
  return `/${parts.join('/')}` === '/' ? '/' : `/${parts.join('/')}`;
}

/** Names of the HTTP method handlers a route file exports. */
export function exportedMethods(content) {
  const found = new Set();
  const text = String(content ?? '');
  for (const m of HTTP) {
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+(?:const|let|var)\\s+${m}\\s*=`);
    if (re.test(text)) found.add(m);
  }
  return [...found];
}

function params(routePath) {
  return [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => x[1]);
}

/**
 * @param files  workspace-relative file paths
 * @param read   (relPath) => string | null, used for App Router method detection
 * @returns { endpoints, framework } endpoints: { method, path, params, file, line, composed }
 */
export function analyzeNext(files, read = () => null) {
  const endpoints = [];

  for (const file of files) {
    const pa = PAGES_API.exec(file);
    if (pa) {
      const routePath = pagesApiPath(pa[1]);
      endpoints.push({ method: 'ALL', path: routePath, params: params(routePath), file, line: null, composed: true });
      continue;
    }
    const ar = APP_ROUTE.exec(file);
    if (ar) {
      const routePath = appRoutePath(ar[1]);
      const methods = exportedMethods(read(file));
      // A route handler with no detectable method export still exists; report it
      // as ALL rather than dropping it.
      for (const method of (methods.length ? methods : ['ALL'])) {
        endpoints.push({ method, path: routePath, params: params(routePath), file, line: null, composed: true });
      }
    }
  }

  return { framework: 'next', endpoints };
}
