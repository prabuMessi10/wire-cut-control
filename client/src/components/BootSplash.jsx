import { LogoMark } from './Icons.jsx';

export default function BootSplash() {
  return (
    <div className="boot-splash">
      <div className="inner">
        <div className="brand-mark">
          <LogoMark />
        </div>
        <div className="spinner" />
      </div>
    </div>
  );
}