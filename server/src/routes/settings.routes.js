/**
 * /api/settings: the self-host configuration surface (Phase 7, BYOK).
 *
 * Read-only, and value-free by construction: settings.service.js reports which
 * environment variables each capability needs and whether they are present, and
 * never touches a value. There is nothing here to write, because AGENTIQ does
 * not store keys: the config lives in the environment, not the database.
 */
import { Router } from 'express';
import { buildConfigSurface } from '../services/settings.service.js';
import { protectRoute } from '../middleware/auth.js';
import { ok } from '../utils/http.js';

const router = Router();

router.get('/config', protectRoute, (req, res) => ok(res, buildConfigSurface()));

export default router;
