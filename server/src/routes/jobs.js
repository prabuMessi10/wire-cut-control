import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createJob, myJobs, allJobs } from '../controllers/jobController.js';

const router = Router();

// Keep "/all" above any param routes. There are none today, but this guards
// against future additions shadowing the admin route.
router.post('/', requireAuth, createJob);
router.get('/mine', requireAuth, myJobs);
router.get('/all', requireAuth, requireRole('admin'), allJobs);

export default router;