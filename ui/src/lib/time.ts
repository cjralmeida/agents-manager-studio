const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

/** "há 3 minutos", "agora" — for activity columns. */
export function timeAgo(iso: string) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'agora';
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86_400), 'day');
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** "1 execução", "9 execuções". */
export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "40 s", "9 min", "1 h 05" — how long something took (or is taking, until now). */
export function formatDuration(fromIso: string, toIso?: string | null) {
  const seconds = Math.max(0, Math.round(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}
