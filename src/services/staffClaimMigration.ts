import { isDeepStrictEqual } from 'node:util';
import type { Auth } from 'firebase-admin/auth';
import { hasRecognizedStaff, withStaffClaim } from '../models/staffClaims.js';

export interface StaffMigrationCheckpoint {
  projectId: string;
  pageToken?: string;
  completed: boolean;
}

type MigrationAuth = Pick<Auth, 'listUsers' | 'getUser' | 'setCustomUserClaims'>;
export interface StaffMigrationOptions {
  projectId: string;
  apply?: boolean;
  cursor?: string;
  saveCheckpoint?: (checkpoint: StaffMigrationCheckpoint) => Promise<void>;
  audit?: (entry: { actor: string; target: string; action: string; outcome: string }) => void;
}

/** No Firebase calls on import. Checkpoint only fully processed pages; retries are idempotent. */
export async function migrateStaffClaims(auth: MigrationAuth, options: StaffMigrationOptions) {
  if (options.apply && !options.saveCheckpoint) throw new Error('Apply requires a checkpoint writer.');
  let cursor = options.cursor;
  let scanned = 0;
  let changed = 0;
  do {
    const page = await auth.listUsers(1000, cursor);
    for (const listed of page.users) {
      scanned++;
      if (!hasRecognizedStaff(listed.customClaims ?? {})) continue;
      try {
        // Re-read on apply to reduce the window for overwriting concurrent claim changes.
        const user = options.apply ? await auth.getUser(listed.uid) : listed;
        const claims = user.customClaims ?? {};
        if (!hasRecognizedStaff(claims)) continue;
        const normalized = withStaffClaim(claims, true);
        if (isDeepStrictEqual(claims, normalized)) continue;
        if (options.apply) await auth.setCustomUserClaims(user.uid, normalized);
        changed++;
        options.audit?.({ actor: 'staff-claims-migration', target: user.uid, action: 'normalize_staff', outcome: options.apply ? 'success' : 'would_change' });
      } catch (error) {
        options.audit?.({ actor: 'staff-claims-migration', target: listed.uid, action: 'normalize_staff', outcome: 'failure' });
        throw error;
      }
    }
    cursor = page.pageToken;
    if (options.apply) await options.saveCheckpoint!({ projectId: options.projectId, pageToken: cursor, completed: !cursor });
  } while (cursor);
  return { scanned, changed, applied: options.apply === true };
}
