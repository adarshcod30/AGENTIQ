/**
 * Route extraction for Python web frameworks: FastAPI and Flask.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §I: "Each framework needs its own extractor."
 * There is no Python AST in Node, so this is pattern-based, in the same
 * high-signal spirit as the SAST scanner. Route decorators are unambiguous
 * (`@app.get("/x")`, `@router.post(...)`, `@app.route("/x", methods=[...])`), so
 * the paths themselves are exact, not "potential". What needs care is composing
 * prefixes: FastAPI's APIRouter(prefix=...) and include_router(..., prefix=...),
 * and Flask's Blueprint(url_prefix=...) and register_blueprint(..., url_prefix=...).
 *
 * Returns the SAME shape as the Express analyzer (routes / mounts / routerPrefixes
 * / imports), so discover_routes composes both the same way.
 */

const PY_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/**
 * Normalises a framework path to the ":param" form the rest of the system uses.
 *   FastAPI: /users/{id}          /files/{path:path}
 *   Flask:   /users/<id>          /users/<int:id>   /files/<path:sub>
 */
export function normalizePyPath(p) {
  return String(p ?? '')
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}/g, ':$1') // {id} / {id:path}
    .replace(/<(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_]*)>/g, ':$1'); // <id> / <int:id>
}

/** Param names from a normalised path. */
export function pyPathParams(p) {
  return [...String(p).matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

const STR = `['"]([^'"]*)['"]`; // a single- or double-quoted string, captured

/** Reads an optional prefix / url_prefix keyword from a call's argument text. */
function readPrefix(argText) {
  const m = new RegExp(`(?:url_)?prefix\\s*=\\s*${STR}`).exec(argText ?? '');
  return m ? m[1] : '';
}

/**
 * Analyzes one Python source file.
 * @returns {{ routes, mounts, routerPrefixes, imports, parseError }}
 */
export function analyzePython(code, { filename = 'unknown' } = {}) { // eslint-disable-line no-unused-vars
  const lines = String(code).split('\n');
  const routes = [];
  const mounts = [];
  const routerPrefixes = {}; // varName -> prefix, from APIRouter(prefix=) / Blueprint(url_prefix=)
  const imports = {}; // localName -> module source (best-effort, for cross-file)

  // A route decorator: @<obj>.<method>("/path"[, methods=[...]])
  const methodDecor = new RegExp(`^\\s*@\\s*([A-Za-z_][\\w.]*)\\.(\\w+)\\s*\\(\\s*${STR}([\\s\\S]*?)\\)\\s*$`);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Router / blueprint definitions with a prefix.
    let m = /^\s*([A-Za-z_]\w*)\s*=\s*APIRouter\s*\(([^)]*)\)/.exec(line);
    if (m) routerPrefixes[m[1]] = readPrefix(m[2]);
    m = /^\s*([A-Za-z_]\w*)\s*=\s*Blueprint\s*\(([\s\S]*?)\)/.exec(line);
    if (m) routerPrefixes[m[1]] = readPrefix(m[2]);

    // Mounts: include_router(x, prefix=) / register_blueprint(x, url_prefix=)
    m = /(?:include_router|register_blueprint)\s*\(\s*([A-Za-z_][\w.]*)([^)]*)\)/.exec(line);
    if (m) {
      const targetVar = m[1].split('.').pop();
      mounts.push({ prefix: readPrefix(m[2]), targets: [{ var: targetVar, import: null }], line: i + 1 });
    }

    // Imports (best-effort): "from a.b import c" and "import a.b as c".
    let im = /^\s*from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
    if (im) {
      for (const name of im[2].split(',')) {
        const clean = name.trim().split(/\s+as\s+/);
        const local = (clean[1] ?? clean[0]).trim();
        if (local && local !== '*') imports[local] = im[1];
      }
    }
    im = /^\s*import\s+([.\w]+)(?:\s+as\s+([A-Za-z_]\w*))?/.exec(line);
    if (im) imports[im[2] ?? im[1].split('.').pop()] = im[1];

    // Route decorators.
    const d = methodDecor.exec(line);
    if (!d) continue;
    const [, obj, called, rawPath, rest] = d;

    if (PY_METHODS.has(called)) {
      // FastAPI/Flask method shortcut: exactly one method.
      routes.push(makeRoute(called.toUpperCase(), rawPath, obj, i + 1));
    } else if (called === 'route') {
      // Flask @app.route("/x", methods=["GET","POST"]) -> one route per method.
      const methodsList = /methods\s*=\s*\[([^\]]*)\]/.exec(rest);
      const methods = methodsList
        ? [...methodsList[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1].toUpperCase())
        : ['GET'];
      for (const method of methods) routes.push(makeRoute(method, rawPath, obj, i + 1));
    } else if (called === 'api_route' || called === 'add_api_route') {
      const methodsList = /methods\s*=\s*\[([^\]]*)\]/.exec(rest);
      const methods = methodsList
        ? [...methodsList[1].matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1].toUpperCase())
        : ['GET'];
      for (const method of methods) routes.push(makeRoute(method, rawPath, obj, i + 1));
    }
  }

  // De-duplicate identical (method, path, via).
  const seen = new Set();
  const deduped = routes.filter((r) => {
    const k = `${r.method} ${r.path} ${r.via}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { routers: Object.keys(routerPrefixes), routes: deduped, mounts, routerPrefixes, imports, parseError: null };
}

function makeRoute(method, rawPath, via, line) {
  const path = normalizePyPath(rawPath);
  return { method, path, params: pyPathParams(path), via, line };
}
