import { Router, Request, Response, NextFunction } from 'express';
import { apiAccess, userAuth } from '../middleware/auth.js';
import { operationService, actorFromRequest, sendOperationError } from '../services/operationService.js';

const router = Router();
router.use(apiAccess({apiKey:'required'}),userAuth('private'));
function handle(fn: (req: Request) => Promise<any>, status = 200) {
  return async (req: Request,res: Response,next: NextFunction) => {
    try { res.setHeader('Cache-Control','private, no-store'); res.status(status).json(await fn(req)); }
    catch(error) { sendOperationError(error,res,next); }
  };
}
router.post('/',handle(req => operationService.begin(actorFromRequest(req),req.body,req.header('Idempotency-Key')!),201));
router.get('/',handle(req => operationService.history(actorFromRequest(req),req.query)));
router.get('/:id',handle(req => operationService.status(actorFromRequest(req),String(req.params.id))));
router.post('/:id/commit',handle(req => operationService.commit(actorFromRequest(req),String(req.params.id),req.header('Idempotency-Key')!)));
router.post('/:id/undo',handle(req => operationService.undo(actorFromRequest(req),String(req.params.id),req.header('Idempotency-Key')!,req.body ?? {})));
router.delete('/:id',handle(req => operationService.cancel(actorFromRequest(req),String(req.params.id),req.header('Idempotency-Key')!)));
export default router;
