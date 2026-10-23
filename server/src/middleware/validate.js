export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const GAUGES = ['26 AWG', '24 AWG', '22 AWG', '20 AWG', '18 AWG', '16 AWG'];

export function badRequest(res, message, code = 'VALIDATION_ERROR') {
  return res.status(400).json({ success: false, error: { code, message } });
}

export function notFound(res, message = 'Resource not found') {
  return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message } });
}

export function isEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}

export function isReasonableString(v, { max = 200, min = 1 } = {}) {
  return (
    typeof v === 'string' &&
    v.trim().length >= min &&
    v.trim().length <= max
  );
}

export const coerceInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
};