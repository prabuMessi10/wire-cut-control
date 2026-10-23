import { AlertIcon, InfoIcon, SuccessIcon } from './Icons.jsx';

const ICONS = { err: AlertIcon, warn: AlertIcon, ok: SuccessIcon, info: InfoIcon };

/** Inline status alert (err / warn / ok / info). */
export default function Alert({ tone = 'err', children }) {
  const Icon = ICONS[tone] || InfoIcon;
  return (
    <div className={`alert ${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <Icon />
      <span>{children}</span>
    </div>
  );
}