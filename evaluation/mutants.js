/**
 * Behavioural mutants for the test-adequacy measurement.
 *
 * docs/01_PRD.md F10 §2, adapting the mutation-score methodology from
 * RESTestBench (arXiv 2604.25862).
 *
 * ── THE ADAPTATION, STATED PLAINLY ──────────────────────────────────────────
 * Classical mutation testing edits the SOURCE (flip an operator, drop a
 * statement) and asks whether the suite notices. That is the right unit when
 * the suite calls functions directly. Here the suite is a set of HTTP requests
 * with assertions, so the only thing it can possibly observe is the RESPONSE.
 * A source edit that never changes any response is trivially unkillable by ANY
 * black-box API suite, and counting such mutants would drag every tool's score
 * toward zero without distinguishing between them.
 *
 * So each mutant here injects one deviation at the RESPONSE BOUNDARY of the
 * hardened app: a wrong status code, a dropped field, a changed type, a wrong
 * content type, an off-by-one in a filter. Every mutant is observable in
 * principle, which makes "did the suite kill it?" a question about the suite
 * rather than about reachability. This is stated in the report rather than
 * quietly assumed, because it materially affects how the score should be read.
 *
 * A mutant is KILLED when at least one generated assertion that PASSES against
 * the unmutated hardened app FAILS against the mutant. Comparing against the
 * baseline rather than just counting failures is what stops a test that was
 * already failing from being credited with a kill it did not earn.
 *
 * ── `appliesTo` AND WHY THE DENOMINATOR MATTERS ─────────────────────────────
 * Each mutant declares the endpoints it can affect. A suite generated for
 * /users/1 sends no request to /items, so it CANNOT kill an /items mutant, and
 * scoring it as "survived" would measure endpoint coverage while claiming to
 * measure assertion quality. Evaluating all 8 mutants against all 8 suites gave
 * a mutation score of 6.3%, which said almost nothing about the generator.
 * Only applicable mutants enter the denominator.
 */
import express from 'express';

/**
 * Wraps an app so one mutation is applied to responses on the way out.
 *
 * Intercepting at `res.json` / `res.send` / `res.status` keeps the mutation
 * declarative and leaves fixtures/hardened-api/server.js byte-identical, which
 * matters, because the contract-identity guarantee in fixtures/tests is what
 * makes the security measurement interpretable at all.
 */
export function applyMutant(baseApp, mutant) {
  const wrapper = express();

  wrapper.use((req, res, next) => {
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origStatus = res.status.bind(res);
    let statusCode = 200;

    res.status = (code) => { statusCode = code; return origStatus(code); };

    res.json = (body) => {
      const out = mutant.mutate({ req, body, statusCode, res });
      if (out?.status !== undefined && out.status !== statusCode) origStatus(out.status);
      if (out?.contentType) res.type(out.contentType);
      if (out?.raw !== undefined) return origSend(out.raw);
      return origJson(out?.body === undefined ? body : out.body);
    };

    res.send = (body) => {
      // HTML routes (/search) are not part of any mutant, so pass them through.
      if (typeof body === 'string') return origSend(body);
      return res.json(body);
    };

    next();
  });

  wrapper.use(baseApp);
  return wrapper;
}

const onPath = (req, method, re) => req.method === method && re.test(req.path);

/**
 * Eight mutants across the four categories F10 names: wrong status code,
 * missing field, off-by-one boundary, wrong content type, plus type changes
 * and an auth regression, which are the failures that actually bite in practice.
 */
export const MUTANTS = [
  {
    id: 'M1',
    category: 'status-code',
    appliesTo: ['users-by-id'],
    title: 'GET /users/:id returns 201 instead of 200',
    kills: 'any assertion on the success status code',
    mutate: ({ req, statusCode }) =>
      (onPath(req, 'GET', /^\/users\/\d+$/) && statusCode === 200 ? { status: 201 } : null),
  },
  {
    id: 'M2',
    category: 'missing-field',
    appliesTo: ['users-by-id'],
    title: 'GET /users/:id omits the email field',
    kills: 'jsonPathExists($.email)',
    mutate: ({ req, body, statusCode }) => {
      if (!onPath(req, 'GET', /^\/users\/\d+$/) || statusCode !== 200) return null;
      const { email, ...rest } = body ?? {};
      return { body: rest };
    },
  },
  {
    id: 'M3',
    category: 'wrong-type',
    appliesTo: ['users-by-id'],
    title: 'GET /users/:id returns id as a string',
    kills: 'jsonPathType($.id, number)',
    mutate: ({ req, body, statusCode }) =>
      (onPath(req, 'GET', /^\/users\/\d+$/) && statusCode === 200
        ? { body: { ...body, id: String(body?.id) } } : null),
  },
  {
    id: 'M4',
    category: 'content-type',
    appliesTo: ['items', 'items-filtered'],
    title: 'GET /items responds as text/plain',
    kills: 'headerEquals(content-type, application/json)',
    mutate: ({ req, body, statusCode }) =>
      (onPath(req, 'GET', /^\/items$/) && statusCode === 200
        ? { contentType: 'text/plain', raw: JSON.stringify(body) } : null),
  },
  {
    id: 'M5',
    category: 'status-code',
    appliesTo: ['users-by-id'],
    title: 'GET /users/:id returns 200 with an empty body for a missing user',
    kills: 'a negative case asserting 404',
    mutate: ({ req, statusCode }) =>
      (onPath(req, 'GET', /^\/users\/\d+$/) && statusCode === 404
        ? { status: 200, body: {} } : null),
  },
  {
    id: 'M6',
    category: 'auth',
    appliesTo: ['admin-users'],
    title: 'GET /admin/users answers 200 without a token',
    kills: 'a negative case asserting 401 for anonymous access',
    mutate: ({ req, statusCode }) =>
      (onPath(req, 'GET', /^\/admin\/users$/) && statusCode === 401
        ? { status: 200, body: { users: [] } } : null),
  },
  {
    id: 'M7',
    category: 'missing-field',
    appliesTo: ['items', 'items-filtered'],
    title: 'GET /items always returns an empty array',
    kills: 'any assertion on array contents or length',
    mutate: ({ req, statusCode }) =>
      (onPath(req, 'GET', /^\/items$/) && statusCode === 200 ? { body: [] } : null),
  },
  {
    id: 'M8',
    category: 'boundary',
    appliesTo: ['items-filtered'],
    title: 'GET /items?ownerId=N returns the rows for N+1',
    kills: 'jsonPathEquals on a filtered result',
    mutate: ({ req, body, statusCode }) => {
      if (!onPath(req, 'GET', /^\/items$/) || statusCode !== 200) return null;
      if (req.query.ownerId === undefined || !Array.isArray(body)) return null;
      // Off by one: the classic filter boundary error.
      const shifted = Number(req.query.ownerId) + 1;
      return { body: body.map((r) => ({ ...r, ownerId: shifted })) };
    },
  },
];

export const MUTANTS_BY_CATEGORY = MUTANTS.reduce((acc, m) => {
  (acc[m.category] ??= []).push(m.id);
  return acc;
}, {});

/** Mutants a suite for `targetId` could possibly kill. */
export const mutantsFor = (targetId) => MUTANTS.filter((m) => m.appliesTo.includes(targetId));
