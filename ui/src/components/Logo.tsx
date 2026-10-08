import { useId } from 'react';

/**
 * The Studio mark ("Órbita"): the core with its agents in orbit, blue working and amber waiting.
 * With `alert`, the amber agent pulses, as it does when an agent is waiting for the user.
 * Same drawing as public/icon.svg.
 */
export function Logo({ size = 28, alert = false }: { size?: number; alert?: boolean }) {
  const gradient = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1c2130" />
          <stop offset="1" stopColor="#0f1115" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${gradient})`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="#2c3344" strokeWidth="1.5" />
      <ellipse cx="32" cy="32" rx="22" ry="10" transform="rotate(-28 32 32)" fill="none" stroke="#7c9cff" strokeWidth="3.5" opacity="0.9" />
      <circle cx="32" cy="32" r="8.5" fill="#e6e9ef" />
      <circle cx="51.4" cy="21.7" r="5" fill="#7c9cff" />
      <circle cx="12.6" cy="42.3" r="5" fill="#fbbf24" className={alert ? 'logo-alert' : undefined} />
    </svg>
  );
}
