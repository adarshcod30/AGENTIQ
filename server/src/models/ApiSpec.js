/**
 * ApiSpec: an imported OpenAPI document and its extracted operations.
 *
 * docs/02_TRD.md §9. Retrieval here means fetching the endpoint's DECLARED
 * contract and grounding generation in it. No vector database, no embeddings:
 * docs/01_PRD.md §4 rules those out, because specification retrieval is what
 * the problem actually needs.
 */
import mongoose from 'mongoose';

const parameterSchema = new mongoose.Schema({
  name: String,
  in: String,
  required: Boolean,
  schema: mongoose.Schema.Types.Mixed,
}, { _id: false });

const operationSchema = new mongoose.Schema({
  operationId: String,
  method: String,
  path: String,
  summary: String,
  parameters: [parameterSchema],
  requestBody: mongoose.Schema.Types.Mixed,
  responses: [{ status: String, description: String, _id: false }],
  security: [String],
}, { _id: false });

const apiSpecSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  title: { type: String, required: true },
  version: { type: String, default: '0.0.0' },
  openapi: { type: String, default: 'unknown' },

  /** Where it came from: a URL, or an uploaded filename. */
  sourceUrl: { type: String, default: null },
  sourceFilename: { type: String, default: null },

  /**
   * The raw document, kept only when small (the threshold is in
   * spec.service.js). Larger documents keep just their extracted operations,
   * so a multi-megabyte spec never sits inside a Mongo document.
   */
  raw: { type: String, default: null },
  byteSize: { type: Number, default: 0 },

  operations: { type: [operationSchema], default: [] },
  operationCount: { type: Number, default: 0 },

  securitySchemes: [{
    name: String, type: { type: String }, scheme: String, _id: false,
  }],
}, { timestamps: true });

apiSpecSchema.index({ userId: 1, createdAt: -1 });

/** Finds one operation by method+path, for grounding a run. */
apiSpecSchema.methods.findOperation = function findOperation(method, path) {
  const m = String(method).toUpperCase();
  return this.operations.find((o) => o.method === m && o.path === path) ?? null;
};

export const ApiSpec = mongoose.models.ApiSpec ?? mongoose.model('ApiSpec', apiSpecSchema, 'apispecs');
export default ApiSpec;
