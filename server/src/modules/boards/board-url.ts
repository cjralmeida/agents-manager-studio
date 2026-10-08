export type ParsedBoardUrl =
  | { provider: 'GITHUB'; host: string; ownerType: 'organization' | 'user'; owner: string; number: number }
  | { provider: 'GITLAB'; host: string; groupPath: string; boardId: number | null };

/**
 * Accepts GitHub project urls (https://github.com/orgs/<org>/projects/<n>, /users/<user>/projects/<n>)
 * and GitLab group board urls (https://gitlab.com/groups/<path>/-/boards[/<id>]).
 */
export function parseBoardUrl(value: string): ParsedBoardUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');

  const github = /^\/(orgs|users)\/([^/]+)\/projects\/(\d+)(?:\/.*)?$/.exec(path);
  if (github) {
    const [, kind, owner = '', number = '0'] = github;
    return { provider: 'GITHUB', host, ownerType: kind === 'orgs' ? 'organization' : 'user', owner, number: Number(number) };
  }

  const gitlab = /^\/groups\/(.+?)\/-\/boards(?:\/(\d+))?$/.exec(path);
  if (gitlab) {
    const [, groupPath = '', boardId] = gitlab;
    return { provider: 'GITLAB', host, groupPath, boardId: boardId ? Number(boardId) : null };
  }
  return null;
}
