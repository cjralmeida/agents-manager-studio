/** Minimal cookie handling (the Studio only has the session cookie). */

export function readCookie(header: string | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean) {
  // HttpOnly keeps the token away from page scripts; SameSite=Lax blocks it on cross-site posts.
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, ...(secure ? ['Secure'] : [])].join('; ');
}
