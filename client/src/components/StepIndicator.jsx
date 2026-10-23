const ORDER = ['idle', 'feeding', 'cutting', 'done'];

/**
 * Idle -> Feeding -> Cutting -> Done step indicator.
 * - state: current step name
 * - error: when true the current step is highlighted in danger red
 */
export default function StepIndicator({ state = 'idle', error = false }) {
  const idx = ORDER.indexOf(state);
  const current = idx === -1 ? 0 : idx;

  return (
    <div className="steps">
      {ORDER.map((name, i) => {
        let cls = 'step';
        if (error && i === current) cls += ' err';
        else if (i < current) cls += ' done';
        else if (i === current) cls += ' active';

        return (
          <div key={name} className={cls} data-step={name}>
            <div className="step-line" />
            <div className="step-dot">{i + 1}</div>
            <div className="step-label">{name}</div>
          </div>
        );
      })}
    </div>
  );
}