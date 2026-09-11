/**
 * Python route extraction (FastAPI and Flask).
 *
 * The paths are exact (decorators are unambiguous); the care is in method
 * expansion (Flask methods=[...]), param normalisation ({id}, <int:id>), and the
 * router/blueprint prefixes the tool composes with.
 */
import { describe, it, expect } from 'vitest';
import { analyzePython, normalizePyPath } from '../src/mcp/analysis/routesPython.js';

describe('normalizePyPath', () => {
  it('normalises FastAPI and Flask params to :name', () => {
    expect(normalizePyPath('/users/{id}')).toBe('/users/:id');
    expect(normalizePyPath('/files/{path:path}')).toBe('/files/:path');
    expect(normalizePyPath('/users/<int:id>')).toBe('/users/:id');
    expect(normalizePyPath('/blog/<slug>')).toBe('/blog/:slug');
  });
});

describe('analyzePython: FastAPI', () => {
  it('extracts app method decorators', () => {
    const { routes } = analyzePython(`
from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health(): return {"ok": True}

@app.post("/users")
def create(): ...
`);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain('GET /health');
    expect(keys).toContain('POST /users');
  });

  it('records an APIRouter prefix and normalises the route path', () => {
    const { routes, routerPrefixes } = analyzePython(`
from fastapi import APIRouter
router = APIRouter(prefix="/users", tags=["users"])

@router.get("/{id}")
def get_user(id: int): ...
`);
    expect(routerPrefixes.router).toBe('/users');
    const r = routes.find((x) => x.method === 'GET');
    expect(r.path).toBe('/:id');
    expect(r.params).toEqual(['id']);
    expect(r.via).toBe('router');
  });

  it('records include_router mounts for cross-file composition', () => {
    const { mounts } = analyzePython(`
from fastapi import FastAPI
from .routers import users
app = FastAPI()
app.include_router(users.router, prefix="/api")
`);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].prefix).toBe('/api');
    expect(mounts[0].targets[0].var).toBe('router');
  });
});

describe('analyzePython: Flask', () => {
  it('expands methods=[...] into one route per method', () => {
    const { routes } = analyzePython(`
from flask import Flask
app = Flask(__name__)

@app.route("/items", methods=["GET", "POST"])
def items(): ...
`);
    const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(['GET /items', 'POST /items']);
  });

  it('defaults a route with no methods to GET', () => {
    const { routes } = analyzePython('@app.route("/ping")\ndef ping(): ...');
    expect(routes).toEqual([expect.objectContaining({ method: 'GET', path: '/ping' })]);
  });

  it('records a Blueprint url_prefix', () => {
    const { routerPrefixes } = analyzePython(`
from flask import Blueprint
admin = Blueprint("admin", __name__, url_prefix="/admin")

@admin.route("/stats")
def stats(): ...
`);
    expect(routerPrefixes.admin).toBe('/admin');
  });

  it('supports Flask 2.0 method shortcuts', () => {
    const { routes } = analyzePython('@app.get("/health")\ndef h(): ...');
    expect(routes[0]).toEqual(expect.objectContaining({ method: 'GET', path: '/health' }));
  });
});
