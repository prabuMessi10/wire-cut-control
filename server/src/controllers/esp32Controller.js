import { getEsp32Status } from '../services/esp32.js';

/** Current ESP32 connection state (used by the header pill / live status card). */
export async function getEsp32StatusHandler(req, res, next) {
  try {
    const status = await getEsp32Status();
    return res.json({ success: true, data: status });
  } catch (err) {
    return next(err);
  }
}
