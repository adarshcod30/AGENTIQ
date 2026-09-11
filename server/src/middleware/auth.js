/**
 * Bearer/cookie JWT authentication.
 *
 *   - One User collection, whichever way the account signs in.
 *   - The token is never logged. A middleware that prints every JWT it sees
 *     puts valid credentials straight into the logs.
 *   - Errors use the { success, error } envelope, like every other route.
 */
import { User } from '../models/User.js';
import { verifyToken } from '../utils/token.js';
import { fail } from '../utils/http.js';

export async function protectRoute(req, res, next) {
  let token = req.cookies?.token;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice('Bearer '.length);
  }

  if (!token) {
    return fail(res, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  let claims;
  try {
    claims = verifyToken(token);
  } catch (err) {
    const expired = err?.name === 'TokenExpiredError';
    return fail(
      res,
      401,
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      expired ? 'Session expired' : 'Invalid token',
    );
  }

  const user = await User.findById(claims.sub);
  if (!user) {
    // The token verified but its subject is gone: treat as unauthenticated
    // rather than 404, which would leak whether an id ever existed.
    return fail(res, 401, 'UNAUTHORIZED', 'Account no longer exists');
  }

  req.user = user;
  req.auth = { userId: String(user._id), email: user.email };
  return next();
}

export default protectRoute;
