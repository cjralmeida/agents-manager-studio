import type { BoardOption } from '../../api/boards';

/** A stable color for an assignee avatar, derived from the login. */
export function avatarColor(login: string) {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 52% 45%)`;
}

export function initials(login: string) {
  const words = login.trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  if (first && second) return (first + second).toUpperCase();
  const clean = login.replace(/[^a-zA-Z0-9]/g, '');
  return (clean.slice(0, 2) || '?').toUpperCase();
}

/** A single circular initials avatar. */
export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  return (
    <span
      title={`@${login}`}
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-panel"
      style={{ width: size, height: size, fontSize: size * 0.42, backgroundColor: avatarColor(login) }}
    >
      {initials(login)}
    </span>
  );
}

/** Overlapping circular initials, ClickUp-style. */
export function AvatarStack({ logins, size = 20 }: { logins: string[]; size?: number }) {
  return (
    <div className="flex items-center">
      {logins.map((login, index) => (
        <span key={login} style={{ marginLeft: index === 0 ? 0 : -size * 0.3, zIndex: logins.length - index }}>
          <Avatar login={login} size={size} />
        </span>
      ))}
    </div>
  );
}

/** A small priority flag, ClickUp-style, colored by the priority option. */
export function PriorityFlag({ option }: { option: BoardOption }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap"
      style={{ color: option.color }}
      title={`Prioridade: ${option.name}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
        <path d="M4 1.5a.75.75 0 0 1 .75.75v.57l1.3-.33a4 4 0 0 1 2.74.26 4 4 0 0 0 2.74.26l1.1-.28a.75.75 0 0 1 .93.73v5.2a.75.75 0 0 1-.57.73l-1.46.36a4 4 0 0 1-2.74-.26 4 4 0 0 0-2.74-.26L4.75 9.7v4.05a.75.75 0 0 1-1.5 0V2.25A.75.75 0 0 1 4 1.5Z" />
      </svg>
      {option.name}
    </span>
  );
}
