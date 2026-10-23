import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getEsp32StatusHandler } from '../controllers/esp32Controller.js';

const router = Router();

router.get('/status', requireAuth, getEsp32StatusHandler);

export default router;