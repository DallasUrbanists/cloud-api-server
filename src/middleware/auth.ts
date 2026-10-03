import { NextFunction, Request, Response } from 'express';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, DecodedIdToken } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import crypto from 'node:crypto';

type ApiKeyRequirement = 'optional' | 'required';
type UserRequirement = 'public' | 'partial' | 'private';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyC3bIA4RfgUnx8Rsfjkxx3HwltPS6o51S0",
  authDomain: "urbanists-mixer-slides-helper.firebaseapp.com",
  projectId: "urbanists-mixer-slides-helper",
  storageBucket: "urbanists-mixer-slides-helper.firebasestorage.app",
  messagingSenderId: "143738155808",
  appId: "1:143738155808:web:385e87e73d547fdaf49d45"
};

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  emails: string[];
  roles: string[];
  token: DecodedIdToken;
}

declare global {
  namespace Express {
    interface Request {
      apiClient?: { name?: string };
      user?: AuthenticatedUser;
    }
  }
}

function firebaseApp() {
  return getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
}

function configuredApiKeys(): Array<{ key: string; name?: string }> {
  const raw = process.env.API_KEYS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { key: string; name?: string } =>
      Boolean(item && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string'),
    );
  } catch {
    console.error('API_KEYS_JSON is not valid JSON.');
    return [];
  }
}

function keysEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

async function verifyAppCheck(req: Request): Promise<void> {
  const token = req.header('X-Firebase-AppCheck');
  if (!token) throw new Error('Missing Firebase App Check token.');
  await getAppCheck(firebaseApp()).verifyToken(token);
}

export function apiAccess(options: { apiKey: ApiKeyRequirement }): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      const suppliedKey = req.header('X-API-Key');
      const keys = configuredApiKeys();
      const client = suppliedKey ? keys.find((entry) => keysEqual(entry.key, suppliedKey)) : undefined;

      if (options.apiKey === 'required' && !client) {
        res.status(401).json({ error: 'Unauthorized', message: 'A valid API key is required.' });
        return;
      }
      if (suppliedKey && !client) {
        res.status(401).json({ error: 'Unauthorized', message: 'The supplied API key is invalid.' });
        return;
      }

      if (client) req.apiClient = { name: client.name };

      const appCheckRequired = process.env.NODE_ENV === 'production' && options.apiKey === 'required';
      if (appCheckRequired) await verifyAppCheck(req);
      next();
    } catch (error) {
      console.warn('Request authentication failed:', error instanceof Error ? error.message : error);
      res.status(401).json({ error: 'Unauthorized', message: 'Application verification failed.' });
    }
  };
}

export function userAuth(requirement: UserRequirement, roles: string[] = []): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const header = req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (!token) {
      if (requirement === 'private') {
        res.status(401).json({ error: 'Unauthorized', message: 'A valid user token is required.' });
        return;
      }
      next();
      return;
    }

    try {
      const decoded = await getAuth(firebaseApp()).verifyIdToken(token);
      const claims = decoded as DecodedIdToken & { roles?: unknown; role?: unknown; staff?: unknown; system?: unknown };
      const claimRoles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : [];
      if (typeof claims.role === 'string') claimRoles.push(claims.role);
      if (claims.staff === true) claimRoles.push('staff');
      if (claims.system === true) claimRoles.push('system');
      const emails = Array.from(new Set([decoded.email, ...((decoded as DecodedIdToken & { emails?: unknown }).emails as string[] || [])].filter((email): email is string => typeof email === 'string')));
      req.user = { uid: decoded.uid, email: decoded.email, emails, roles: Array.from(new Set(claimRoles)), token: decoded };

      if (requirement === 'private' && roles.length > 0 && !roles.some((role) => req.user!.roles.includes(role))) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to perform this action.' });
        return;
      }
      next();
    } catch {
      if (requirement === 'private') {
        res.status(401).json({ error: 'Unauthorized', message: 'A valid user token is required.' });
        return;
      }
      next();
    }
  };
}

export function hasRole(req: Request, role: string): boolean {
  return Boolean(req.user?.roles.includes(role));
}
