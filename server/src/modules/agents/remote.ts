export interface RemoteInfo {
  /** Host with optional port for https remotes (e.g. gitlab.com, git.company.com:8443). */
  host: string;
  /** Repository path without leading slash and without ".git" (e.g. group/sub/repo). */
  path: string;
}

/** Parses https://host/path(.git), ssh://user@host[:port]/path and scp-like user@host:path remotes. */
export function parseRemote(url: string): RemoteInfo | null {
  const trimmed = url.trim();
  const withScheme = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);
  if (withScheme) {
    const [, scheme = '', host = '', port, path = ''] = withScheme;
    // Ssh ports do not apply to https, which is what pushes and APIs use.
    const keepPort = port && /^https?$/i.test(scheme);
    return { host: (keepPort ? `${host}:${port}` : host).toLowerCase(), path: cleanPath(path) };
  }
  const scpLike = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scpLike) {
    const [, host = '', path = ''] = scpLike;
    return { host: host.toLowerCase(), path: cleanPath(path) };
  }
  return null;
}

function cleanPath(path: string) {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

/** Hostname without port, used to match git accounts (accounts store the API host). */
export function remoteHostname(remote: RemoteInfo) {
  return remote.host.split(':')[0] ?? remote.host;
}

/** Authenticated https url for a single push; never stored in git config. */
export function authenticatedPushUrl(remote: RemoteInfo, provider: 'GITHUB' | 'GITLAB', token: string) {
  const user = provider === 'GITHUB' ? 'x-access-token' : 'oauth2';
  return `https://${user}:${encodeURIComponent(token)}@${remote.host}/${remote.path}.git`;
}
