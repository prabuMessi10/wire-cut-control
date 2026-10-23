import { useMemo, useRef } from 'react';

/**
 * Draggable tape-measure style length control - the signature UI element of the
 * reference design. Graduated ticks, drag-to-set, synced numeric input and a
 * mm / cm / inch unit toggle. Faithful port of the original JS behaviour.
 *
 * Controlled component: valueMm / onChange(millimeters) / unit / onUnitChange.
 */
export default function RulerControl({ valueMm, maxMm, unit, onChange, onUnitChange }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  const clamp = (v) => Math.max(0, Math.min(maxMm, Math.round(v)));

  const convertFromMm = (mm, u) => {
    if (u === 'cm') return Math.round((mm / 10) * 10) / 10;
    if (u === 'in') return Math.round((mm / 25.4) * 100) / 100;
    return mm;
  };
  const convertToMm = (val, u) => {
    if (u === 'cm') return val * 10;
    if (u === 'in') return val * 25.4;
    return val;
  };

  const trackToMm = (clientX) => {
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * maxMm;
  };

  const handlePointerDown = (e) => {
    draggingRef.current = true;
    onChange(clamp(trackToMm(e.clientX)));
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e) => {
    if (!draggingRef.current) return;
    onChange(clamp(trackToMm(e.clientX)));
  };
  const endDrag = () => {
    draggingRef.current = false;
  };

  const handleKeyDown = (e) => {
    let delta = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -1;
    if (e.key === 'Home') return onChange(0);
    if (e.key === 'End') return onChange(maxMm);
    if (delta === 0) return;
    e.preventDefault();
    onChange(clamp(valueMm + delta));
  };

  const handleInputChange = (e) => {
    const raw = e.target.value === '' ? 0 : parseFloat(e.target.value);
    if (Number.isNaN(raw)) return;
    onChange(clamp(convertToMm(raw, unit)));
  };

  const pct = maxMm > 0 ? Math.min(100, (valueMm / maxMm) * 100) : 0;

  const ticks = useMemo(() => {
    // Adapt the step to the range: a fixed small step would render ~10,000
    // DOM nodes when an admin raises maxLenMm to 100,000 mm. Total ticks
    // stay around 100 and major labels around 10 for any valid range.
    const minorStep =
      maxMm <= 100 ? 1 : maxMm <= 500 ? 5 : maxMm <= 2000 ? 25 : maxMm <= 10000 ? 100 : maxMm <= 50000 ? 500 : 1000;
    const majorStep = Math.max(100, Math.ceil(maxMm / 10 / minorStep) * minorStep);
    const out = [];
    for (let v = 0; v <= maxMm; v += minorStep) {
      const isMajor = v % majorStep === 0;
      out.push({ v, isMajor, left: (v / maxMm) * 100 });
    }
    return out;
  }, [maxMm]);

  return (
    <div className="ruler-wrap">
      <div className="ruler-readout">
        <span className="val">{convertFromMm(valueMm, unit)}</span>
        <span className="unit">{unit}</span>
      </div>

      <div
        ref={trackRef}
        className="ruler-track"
        role="slider"
        tabIndex={0}
        aria-label="Wire length"
        aria-valuemin={0}
        aria-valuemax={maxMm}
        aria-valuenow={Math.round(valueMm)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
      >
        <div className="ruler-fill" style={{ width: `${pct}%` }} />
        <div className="ruler-ticks">
          {ticks.map((t) => (
            <span key={`tick-${t.v}`}>
              <span
                className={t.isMajor ? 'tick major' : 'tick'}
                style={{ left: `${t.left}%`, height: t.isMajor ? 16 : 9 }}
              />
              {t.isMajor && (
                <span className="tick-label" style={{ left: `${t.left}%` }}>
                  {t.v}
                </span>
              )}
            </span>
          ))}
        </div>
        <div className="ruler-handle" style={{ left: `${pct}%` }} />
      </div>

      <p className="ruler-hint">Drag along the scale or type an exact value below</p>
    </div>
  );
}