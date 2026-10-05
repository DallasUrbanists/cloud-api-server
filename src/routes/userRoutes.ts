import { Router, type RequestHandler } from 'express';
import { StaffClaimController } from '../controllers/staffClaimController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';
import { StaffClaimService } from '../services/staffClaimService.js';

export const auditStaffClaim: RequestHandler = (req, res, next) => {
  const target = req.params.uid;
  res.once('finish', () => {
    console.info(JSON.stringify({
      event: 'staff_claim_administration',
      actor: req.user?.uid ?? null,
      target,
      action: req.method === 'PUT' ? 'assign_staff' : 'remove_staff',
      outcome: res.statusCode === 204 ? 'success' : 'failure',
      status: res.statusCode,
    }));
  });
  next();
};

export function createUserRoutes(service = new StaffClaimService()): Router {
  const router = Router();
  const controller = new StaffClaimController(service);
  const handlers = [auditStaffClaim, apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), controller.update];
  router.put('/:uid/claims/staff', ...handlers);
  router.delete('/:uid/claims/staff', ...handlers);
  return router;
}

export default createUserRoutes();
