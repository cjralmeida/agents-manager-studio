/** Host of a git remote url (https://host/..., ssh://git@host/... or git@host:path). */
export function remoteHost(url: string): string | null {
  return /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1]?.toLowerCase() ?? null;
}
