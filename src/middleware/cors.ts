import { Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';

/**
 * Checks whether an origin is a local development origin.
 */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

const DEFAULT_AUTHORIZED_ORIGINS = [
  'https://map.dallasurbanists.org',
  'https://api.dallasurbanists.org',
  'https://dallasurbanists.org',
  'https://dallasurbanists.github.io',
  'https://dallasurbanists.web.app',
  'https://dallasurbanists.firebaseapp.com',
];

/**
 * Retrieves the configured list of authorized domain origins.
 */
export function getAuthorizedOrigins(): string[] {
  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (!envOrigins) {
    return DEFAULT_AUTHORIZED_ORIGINS;
  }
  const customOrigins = envOrigins
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_AUTHORIZED_ORIGINS, ...customOrigins]));
}

/**
 * Verifies if an origin is permitted to access the API.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Allow requests without Origin header (e.g. mobile apps, curl, Postman, server-to-server)
  if (!origin) {
    return true;
  }

  // Always allow local development requests
  if (isLocalOrigin(origin)) {
    return true;
  }

  const authorized = getAuthorizedOrigins();
  const normalizedOrigin = origin.replace(/\/$/, '');

  return authorized.some((allowed) => {
    // Exact match or wildcard subdomain match (e.g. *.dallasurbanists.org)
    if (allowed.startsWith('*.')) {
      const baseDomain = allowed.slice(2);
      try {
        const url = new URL(normalizedOrigin);
        return url.hostname.endsWith(baseDomain);
      } catch {
        return false;
      }
    }
    return allowed === normalizedOrigin;
  });
}

/**
 * Configured CORS middleware for Express.
 */
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS Error: Origin '${origin}' is not authorized to access this API.`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
};

export const corsMiddleware = cors(corsOptions);

/**
 * Fallback middleware to handle CORS errors gracefully with 403 Forbidden.
 */
export function corsErrorHandler(
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err && err.message && err.message.startsWith('CORS Error')) {
    res.status(403).json({
      error: 'Forbidden',
      message: err.message,
    });
    return;
  }
  next(err);
}
