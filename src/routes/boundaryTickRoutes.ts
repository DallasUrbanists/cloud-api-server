import { Router } from 'express';
import { getSyncJob, tick } from '../controllers/boundariesController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';
const router = Router();
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.path.startsWith('/jobs/') && (req.method === 'HEAD' || /prefetch|prerender/i.test(`${req.header('Purpose') ?? ''} ${req.header('Sec-Purpose') ?? ''}`))) {
    res.status(405).setHeader('Allow', /^\/(?:boundary|representative)\//i.test(req.path) ? 'GET, POST' : 'GET');
    res.json({ error: 'METHOD_NOT_ALLOWED', message: 'Prefetch and HEAD requests cannot trigger synchronization.' });
    return;
  }
  next();
});
router.get('/boundaries/shape', tick('boundary', 'shape'));
router.get('/boundaries/research', tick('boundary', 'research'));
router.get('/boundary/:id', tick('boundary', undefined, true));
router.get('/representatives', tick('representative', 'research'));
router.get('/representative/:id', tick('representative', 'research', true));
router.get('/jobs/:id', getSyncJob);
router.post('/boundary/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), tick('boundary', undefined, true, true));
router.post('/representative/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), tick('representative', 'research', true, true));
export default router;
