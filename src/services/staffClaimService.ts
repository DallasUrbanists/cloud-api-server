import { getAuth, type Auth } from 'firebase-admin/auth';
import { firebaseApp } from '../config/firebase.js';
import { withStaffClaim } from '../models/staffClaims.js';
import { isStaging } from '../config/deployment.js';

type ClaimAuth = Pick<Auth, 'getUser' | 'setCustomUserClaims' | 'revokeRefreshTokens'>;

export class StaffClaimService {
  constructor(private readonly authProvider: () => ClaimAuth = () => getAuth(firebaseApp())) {}

  /** Updates shared claims and revokes removed staff sessions; always refuses staging. */
  async setStaff(uid: string, staff: boolean): Promise<void> {
    if (isStaging()) throw new Error('Shared user administration is disabled in staging.');
    const auth = this.authProvider();
    const target = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, withStaffClaim(target.customClaims ?? {}, staff));
    // Always revoke on deletion, even when the claim was already absent.
    // A revocation failure is a failed operation; retry DELETE to complete it.
    if (!staff) await auth.revokeRefreshTokens(uid);
  }
}
