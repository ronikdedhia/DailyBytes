import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '@clerk/backend';
import { logger } from '../utils/logger';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        firstName?: string;
        lastName?: string;
      };
    }
  }
}

type AuthUser = NonNullable<Request['user']>;

function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  return token || null;
}

/**
 * Verifies a Clerk session token's signature, expiry and (if ALLOWED_ORIGIN is
 * set) its authorized party. Uses CLERK_JWT_KEY for networkless verification
 * when available, otherwise CLERK_SECRET_KEY to fetch Clerk's JWKS.
 * Throws if the token is invalid or no verification key is configured.
 */
export async function verifySessionToken(token: string): Promise<AuthUser> {
  const jwtKey = process.env.CLERK_JWT_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!jwtKey && !secretKey) {
    throw new Error('CLERK_JWT_KEY or CLERK_SECRET_KEY must be set to verify tokens');
  }

  const authorizedParties = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const payload = await verifyToken(token, { jwtKey, secretKey, authorizedParties });
  if (!payload.sub) throw new Error('Token has no subject');

  // email / given_name / family_name are only present if the Clerk session
  // token has been customised to include them.
  const claims = payload as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    id: payload.sub,
    email: str(claims.email),
    firstName: str(claims.given_name),
    lastName: str(claims.family_name),
  };
}

export async function verifyClerkToken(req: Request, res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing or invalid authorization header',
    });
  }

  try {
    req.user = await verifySessionToken(token);
  } catch (error: any) {
    logger.warn(`Token verification failed: ${error.message}`);
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
  next();
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = getBearerToken(req);
  if (token) {
    try {
      req.user = await verifySessionToken(token);
    } catch (error: any) {
      // An invalid token is treated as anonymous, never as the claimed user.
      req.user = undefined;
      logger.warn(`Optional auth token rejected, continuing without user: ${error.message}`);
    }
  }
  next();
}
