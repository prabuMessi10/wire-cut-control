import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  getPending,
  approveUser,
  rejectUser,
  createEmployee,
  listEmployees,
  deleteEmployee,
} from '../controllers/userController.js';

const router = Router();

// Every user-management route is admin-only.
router.use(requireAuth, requireRole('admin'));

router.get('/pending', getPending);
router.post('/:id/approve', approveUser);
router.post('/:id/reject', rejectUser);
router.post('/', createEmployee);
router.get('/', listEmployees);
router.delete('/:id', deleteEmployee);

export default router;