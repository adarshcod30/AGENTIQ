/**
 * Route extraction by AST. Pure: source text in, structured routes out. No I/O.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D, §E. This is the deterministic core of
 * discovery: an LLM is never asked "what are the routes", because a parser can
 * answer that exactly and reproducibly. The LLM's job (a later phase) is to
 * infer what each discovered route is FOR, not to find them.
 *
 * A proof-of-concept over the fixtures surfaced the two problems this module
 * exists to solve:
 *
 *   1. FALSE POSITIVES. `req.get('origin')` is Express's header getter and looks
 *      identical to `router.get('/path', handler)` at the syntax level. We only
 *      match method calls on identifiers we have SEEN assigned an Express app or
 *      router (`express()`, `express.Router()`, `Router()`), never on an
 *      arbitrary object. A route with no handler argument is also rejected: a
 *      real route always has at least one handler.
 *
 *   2. MOUNT PREFIXES. A router defined as `/users` and mounted with
 *      `app.use('/api', usersRouter)` serves `/api/users`. We record both the
 *      routes and the mounts so the caller can compose full paths, within a file
 *      and (in discover_routes) across files.
 *
 * Scope: Express and compatible routers (the router object exposes `.get`,
 * `.post`, and so on). Other frameworks get their own extractor; the plan is
 * explicit that framework coverage is a long tail.
 */
import { parse } from '@babel/parser';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/** Path params from an Express path: /users/:id/posts/:postId -> ['id', 'postId']. */
export function pathParams(p) {
  return [...String(p).matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

/** Depth-first walk, calling visit on every AST node. */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/** `express` (default import) or `Router` (named import) bound to a local name. */
function collectExpressBindings(ast) {
  const expressLocal = new Set(); // local names bound to the express default export
  const routerLocal = new Set(); // local names bound to express's Router

  walk(ast, (n) => {
    // import express from 'express'  |  import { Router } from 'express'
    if (n.type === 'ImportDeclaration' && n.source?.value === 'express') {
      for (const s of n.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') expressLocal.add(s.local.name);
        if (s.type === 'ImportSpecifier' && s.imported?.name === 'Router') routerLocal.add(s.local.name);
      }
    }
    // const express = require('express')  |  const { Router } = require('express')
    if (n.type === 'VariableDeclarator' && isRequireOf(n.init, 'express')) {
      if (n.id.type === 'Identifier') expressLocal.add(n.id.name);
      if (n.id.type === 'ObjectPattern') {
        for (const prop of n.id.properties) {
          if (prop.key?.name === 'Router' && prop.value?.type === 'Identifier') {
            routerLocal.add(prop.value.name);
          }
        }
      }
    }
  });

  return { expressLocal, routerLocal };
}

function isRequireOf(node, moduleName) {
  return node?.type === 'CallExpression'
    && node.callee?.name === 'require'
    && node.arguments?.[0]?.type === 'StringLiteral'
    && node.arguments[0].value === moduleName;
}

/** Is `init` a call that produces an Express app or router? */
function producesRouter(init, { expressLocal, routerLocal }) {
  if (init?.type !== 'CallExpression' && init?.type !== 'NewExpression') return null;
  const callee = init.callee;
  // express()  -> an app
  if (callee?.type === 'Identifier' && expressLocal.has(callee.name)) return 'app';
  // Router()  (named import)  -> a router
  if (callee?.type === 'Identifier' && routerLocal.has(callee.name)) return 'router';
  // express.Router()  -> a router
  if (callee?.type === 'MemberExpression'
    && callee.object?.type === 'Identifier' && expressLocal.has(callee.object.name)
    && callee.property?.name === 'Router') return 'router';
  return null;
}

/** Map every local variable that holds an app or router to its kind. */
function collectRouterVars(ast, bindings) {
  const vars = new Map(); // name -> 'app' | 'router'
  walk(ast, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier') return;
    const kind = producesRouter(n.init, bindings);
    if (kind) vars.set(n.id.name, kind);
  });
  return vars;
}

/** import/require local name -> module source, for resolving mount targets. */
function collectImports(ast) {
  const imports = new Map();
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration' && n.source?.value) {
      for (const s of n.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') imports.set(s.local.name, n.source.value);
      }
    }
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier'
      && n.init?.type === 'CallExpression' && n.init.callee?.name === 'require'
      && n.init.arguments?.[0]?.type === 'StringLiteral') {
      imports.set(n.id.name, n.init.arguments[0].value);
    }
  });
  return imports;
}

/**
 * Analyzes one source file.
 *
 * @returns {{ routers, routes, mounts, imports, parseError }}
 *   routes: { method, path, params, handlerCount, via, line }
 *   mounts: { prefix, targetVar, targetImport, line }  from app.use(prefix, X)
 */
export function analyzeSource(code, { filename = 'unknown' } = {}) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      plugins: ['typescript', ...(/\.[jt]sx$/.test(filename) ? ['jsx'] : [])],
      errorRecovery: true,
    });
  } catch (err) {
    return { routers: [], routes: [], mounts: [], imports: {}, parseError: err.message };
  }

  const bindings = collectExpressBindings(ast);
  const routerVars = collectRouterVars(ast, bindings);
  const imports = collectImports(ast);
  const routes = [];
  const mounts = [];

  walk(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression') return;
    const objectName = n.callee.object?.type === 'Identifier' ? n.callee.object.name : null;
    const method = n.callee.property?.name;
    const first = n.arguments?.[0];

    // A route call: <router>.<method>('/path', ...handlers)
    if (HTTP_METHODS.has(method) && first?.type === 'StringLiteral') {
      const isKnownRouter = objectName && routerVars.has(objectName);
      const handlerCount = n.arguments.length - 1;
      // Only accept calls on a known app/router, OR (as a weaker fallback for
      // routers we could not statically bind) a conventionally named object with
      // at least one handler. This is what rejects `req.get('origin')`.
      const conventional = /^(app|router|r|api)$/i.test(objectName ?? '') && handlerCount >= 1;
      if (isKnownRouter || conventional) {
        routes.push({
          method: method.toUpperCase(),
          path: first.value,
          params: pathParams(first.value),
          handlerCount,
          via: objectName,
          line: n.loc?.start.line ?? null,
        });
      }
      return;
    }

    // A mount: <app>.use('/prefix', router)
    if (method === 'use' && first?.type === 'StringLiteral' && n.arguments.length >= 2) {
      const target = n.arguments[1];
      mounts.push({
        prefix: first.value,
        targetVar: target?.type === 'Identifier' ? target.name : null,
        targetImport: isRequireOf(target, undefined) ? target.arguments[0]?.value : null,
        line: n.loc?.start.line ?? null,
      });
    }
  });

  // De-duplicate identical (method, path) routes, keeping the first.
  const seen = new Set();
  const deduped = routes.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    routers: [...routerVars.keys()],
    routes: deduped,
    mounts,
    imports: Object.fromEntries(imports),
    parseError: null,
  };
}

/** Join a mount prefix and a route path into one clean path. */
export function joinPath(prefix, routePath) {
  const a = String(prefix ?? '').replace(/\/+$/, '');
  const b = String(routePath ?? '');
  if (!a) return b || '/';
  if (b === '/' || b === '') return a || '/';
  return `${a}${b.startsWith('/') ? '' : '/'}${b}`;
}
