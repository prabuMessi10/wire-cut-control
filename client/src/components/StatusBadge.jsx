const TONES = ['ok', 'warn', 'err', 'idle', 'info'];

/** Small status pill badge (ok / warn / err / idle / info). */
export default function StatusBadge({ tone = 'idle', dot = false, children }) {
  return (
    <span className={`badge ${TONES.includes(tone) ? tone : 'idle'}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}