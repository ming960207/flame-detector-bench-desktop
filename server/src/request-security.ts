import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER_NAME = 'x-desktop-session';

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Packaged Electron sets DESKTOP_API_TOKEN and injects the matching header at
 * the session network layer. Development remains convenient, while a
 * production standalone server must opt in explicitly if it wants unauthenticated
 * localhost mutations.
 */
export const requireDesktopMutation: RequestHandler = (req, res, next) => {
  const expected = process.env.DESKTOP_API_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNAUTHENTICATED_LOCAL_MUTATIONS !== 'true') {
      return res.status(503).json({ code: 'DESKTOP_SESSION_NOT_CONFIGURED' });
    }
    return next();
  }
  const supplied = req.get(HEADER_NAME) ?? '';
  if (!supplied || !secureEquals(supplied, expected)) {
    return res.status(403).json({ code: 'DESKTOP_SESSION_REQUIRED' });
  }
  return next();
};
