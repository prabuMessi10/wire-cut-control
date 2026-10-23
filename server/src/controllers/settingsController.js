import { getSettings, updateSettings } from '../services/settings.js';
import { badRequest } from '../middleware/validate.js';

/** Current machine-level settings (demo mode, ESP32 IP, max length). */
export async function getSettingsHandler(req, res, next) {
  try {
    const settings = await getSettings();
    return res.json({ success: true, data: { settings } });
  } catch (err) {
    return next(err);
  }
}

/** Update machine-level settings. */
export async function updateSettingsHandler(req, res, next) {
  try {
    const { demoMode, esp32Ip, maxLenMm } = req.body || {};
    const patch = {};

    if (demoMode !== undefined) {
      if (typeof demoMode !== 'boolean') return badRequest(res, 'demoMode must be a boolean.');
      patch.demoMode = demoMode;
    }
    if (esp32Ip !== undefined) {
      if (typeof esp32Ip !== 'string') return badRequest(res, 'esp32Ip must be a string.');
      if (esp32Ip.trim() && !/^[\w.:-]+$/.test(esp32Ip.trim())) {
        return badRequest(res, 'esp32Ip does not look like a valid host/IP.');
      }
      patch.esp32Ip = esp32Ip;
    }
    if (maxLenMm !== undefined) {
      const n = Number(maxLenMm);
      if (!Number.isFinite(n) || n < 50 || n > 100000) {
        return badRequest(res, 'maxLenMm must be between 50 and 100000.');
      }
      patch.maxLenMm = n;
    }
    if (Object.keys(patch).length === 0) {
      return badRequest(res, 'Nothing to update - provide demoMode, esp32Ip or maxLenMm.');
    }

    const settings = await updateSettings(patch);
    return res.json({ success: true, data: { settings } });
  } catch (err) {
    return next(err);
  }
}