import StatusBadge from './StatusBadge.jsx';

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString([], {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Job history table.
 * - showEmployee: adds the Employee + Reference columns (admin view)
 */
export default function JobsTable({ jobs = [], showEmployee = false, emptyText = 'No jobs sent yet' }) {
  const colCount = showEmployee ? 6 : 5;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {showEmployee && <th>Employee</th>}
            <th>Time</th>
            <th>Length</th>
            <th>Qty</th>
            <th>Gauge</th>
            {showEmployee && <th>Reference</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 ? (
            <tr className="empty-row">
              <td colSpan={colCount}>{emptyText}</td>
            </tr>
          ) : (
            jobs.map((j) => (
              <tr key={j.id}>
                {showEmployee && <td>{j.requestedBy?.name || '—'}</td>}
                <td className="mono">{formatTime(j.createdAt)}</td>
                <td className="mono">{j.lengthMm} mm</td>
                <td className="mono">{j.qty}</td>
                <td>{j.gauge}</td>
                {showEmployee && <td>{j.ref || '—'}</td>}
                <td>
                  <StatusBadge tone={j.status === 'done' ? 'ok' : 'err'}>
                    {j.status === 'done' ? 'Done' : 'Error'}
                  </StatusBadge>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}