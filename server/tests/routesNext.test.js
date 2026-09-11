/**
 * Next.js route extraction (filesystem convention).
 *
 * The URL is the file path, so these tests pin the path mapping: dynamic
 * segments, catch-alls, index files, the src/ prefix, and App Router route
 * groups, plus reading which HTTP methods a route handler exports.
 */
import { describe, it, expect } from 'vitest';
import { analyzeNext, exportedMethods } from '../src/mcp/analysis/routesNext.js';

const paths = (endpoints) => endpoints.map((e) => `${e.method} ${e.path}`).sort();

describe('Next Pages Router API', () => {
  it('maps dynamic, catch-all, index and src-prefixed files', () => {
    const { endpoints } = analyzeNext([
      'pages/api/users/[id].ts',
      'pages/api/posts/[...slug].ts',
      'pages/api/health/index.ts',
      'src/pages/api/ping.ts',
      'pages/index.tsx', // a UI page, not an API route: ignored
    ]);
    expect(paths(endpoints)).toEqual([
      'ALL /api/health', 'ALL /api/ping', 'ALL /api/posts/*', 'ALL /api/users/:id',
    ]);
    expect(endpoints.find((e) => e.path === '/api/users/:id').params).toEqual(['id']);
  });
});

describe('Next App Router route handlers', () => {
  it('reads exported methods and drops route groups', () => {
    const files = ['app/(admin)/stats/route.ts', 'app/users/[id]/route.ts'];
    const read = (f) => (f.includes('stats')
      ? 'export async function GET() {}'
      : 'export async function GET() {}\nexport const POST = async () => {}');
    const { endpoints } = analyzeNext(files, read);
    expect(paths(endpoints)).toEqual(['GET /stats', 'GET /users/:id', 'POST /users/:id']);
  });

  it('reports a handler with no detectable method as ALL rather than dropping it', () => {
    const { endpoints } = analyzeNext(['app/webhook/route.ts'], () => '// dynamic handler');
    expect(endpoints).toEqual([expect.objectContaining({ method: 'ALL', path: '/webhook' })]);
  });

  it('maps the root app/route.ts to /', () => {
    const { endpoints } = analyzeNext(['app/route.ts'], () => 'export function GET() {}');
    expect(endpoints[0]).toEqual(expect.objectContaining({ method: 'GET', path: '/' }));
  });
});

describe('exportedMethods', () => {
  it('detects both function and const export forms', () => {
    expect(exportedMethods('export function GET(){}\nexport const DELETE = () => {}').sort())
      .toEqual(['DELETE', 'GET']);
  });
});
