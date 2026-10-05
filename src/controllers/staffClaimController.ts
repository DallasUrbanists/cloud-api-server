import type { Request, Response } from 'express';
import { StaffClaimService } from '../services/staffClaimService.js';

export class StaffClaimController {
  constructor(private readonly service: StaffClaimService = new StaffClaimService()) {}

  update = async (req: Request, res: Response): Promise<void> => {
    const uid = req.params.uid;
    if (typeof uid !== 'string' || uid.length === 0 || uid.length > 128) {
      res.status(400).json({ error: 'BadRequest', message: 'Firebase UID must contain 1 to 128 characters.' });
      return;
    }
    // Defense in depth: system and legacy role claims must never authorize this API.
    if (!req.user || req.user.token.staff !== true || uid === req.user.uid) {
      res.status(403).json({ error: 'Forbidden', message: 'Canonical staff authorization is required and self-targeting is forbidden.' });
      return;
    }
    try {
      await this.service.setStaff(uid, req.method === 'PUT');
      res.status(204).end();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'auth/user-not-found') {
        res.status(404).json({ error: 'NotFound', message: 'The target Firebase user does not exist.' });
      } else if (code === 'auth/invalid-uid') {
        res.status(400).json({ error: 'BadRequest', message: 'The target Firebase UID is invalid.' });
      } else {
        res.status(500).json({ error: 'InternalServerError', message: 'Staff claim update failed.' });
      }
    }
  };
}
