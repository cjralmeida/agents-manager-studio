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
