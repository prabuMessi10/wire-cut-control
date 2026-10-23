import AppSetting from '../models/AppSetting.js';

const DEFAULTS = {
  demoMode: process.env.ESP32_DEMO_DEFAULT === 'false' ? false : true,
  esp32Ip: process.env.ESP32_IP || '',
  maxLenMm: 1000,
};

/**
 * In-memory simulated machine state, used while a demo-cycle is running so the
 * GET /api/esp32/status endpoint can report feeding -> cutting -> done, exactly
 * like a real ESP32 would.
 */
const simState = { state: 'idle', startedAt: null, updatedAt: Date.now() };

export function getSimState() {
  return { ...simState };
}

export function setSimState(state) {
  simState.state = state;
  simState.updatedAt = Date.now();
  if (state === 'feeding' && !simState.startedAt) simState.startedAt = Date.now();
  if (state === 'idle') simState.startedAt = null;
}

async function getSetting(key) {
  const doc = await AppSetting.findOne({ key }).lean();
  return doc ? doc.value : undefined;
}

async function setSetting(key, value) {
  await AppSetting.findOneAndUpdate({ key }, { $set: { value } }, { upsert: true });
}

/** Read the current machine-level settings (falls back to .env defaults). */
export async function getSettings() {
  const [demoMode, esp32Ip, maxLenMm] = await Promise.all([
    getSetting('demoMode'),
    getSetting('esp32Ip'),
    getSetting('maxLenMm'),
  ]);
  const parsedMax =
    maxLenMm === undefined ? DEFAULTS.maxLenMm : Number(maxLenMm);
  return {
    demoMode: demoMode === undefined ? DEFAULTS.demoMode : Boolean(demoMode),
    esp32Ip: esp32Ip === undefined ? DEFAULTS.esp32Ip : String(esp32Ip),
    // Guard against a corrupt value so the job-length cap can never be
    // silently disabled (length_mm > NaN is always false).
    maxLenMm: Number.isFinite(parsedMax) ? parsedMax : DEFAULTS.maxLenMm,
  };
}

/** Persist a partial settings patch and return the merged result. */
export async function updateSettings(patch) {
  if (typeof patch.demoMode === 'boolean') await setSetting('demoMode', patch.demoMode);
  if (typeof patch.esp32Ip === 'string') await setSetting('esp32Ip', patch.esp32Ip.trim());
  if (typeof patch.maxLenMm === 'number') await setSetting('maxLenMm', patch.maxLenMm);
  return getSettings();
}