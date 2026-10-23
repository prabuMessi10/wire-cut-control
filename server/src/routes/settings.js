import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getSettingsHandler,
  updateSettingsHandler,
} from '../controllers/settingsController.js';

const router = Router();

// Any authenticated (approved) user can view machine settings; both roles can
// update them - matches the Settings drawer in the reference UI. Production
// deployments can tighten this with requireRole('admin').
router.use(requireAuth);
router.get('/', getSettingsHandler);
router.put('/', updateSettingsHandler);

export default router;