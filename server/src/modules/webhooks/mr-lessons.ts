import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { secrets } from '../../lib/secrets.js';
import { commentPullRequest } from '../agents/pull-requests.js';
import { parseRemote, remoteHostname } from '../agents/remote.js';
import { findWorkspaceGitAccount } from '../git-accounts/workspace-account.js';

type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const sentKey = (url: string) => `mr-lessons:${url}`;

/** The PR/MR a delivery says was just opened (or reopened), or null for any other event. */
function openedPullRequest(provider: 'GITHUB' | 'GITLAB', payload: Json) {
  if (provider === 'GITLAB') {
    if (payload.object_kind !== 'merge_request') return null;
    const mr = payload.object_attributes as Json | undefined;
    const project = payload.project as Json | undefined;
    if (!mr || !['open', 'reopen'].includes(String(mr.action))) return null;
    const repoUrl = text(project?.web_url);
    const url = text(mr.url);
    return repoUrl && url && typeof mr.iid === 'number' ? { repoUrl, url, number: mr.iid, branch: text(mr.source_branch) ?? '' } : null;
  }
  const pull = payload.pull_request as Json | undefined;
  const repository = payload.repository as Json | undefined;
  if (!pull || !['opened', 'reopened'].includes(String(payload.action))) return null;
  const repoUrl = text(repository?.html_url);
  const url = text(pull.html_url);
  const branch = text((pull.head as Json | undefined)?.ref) ?? '';
  return repoUrl && url && typeof pull.number === 'number' ? { repoUrl, url, number: pull.number, branch } : null;
}

/**
 * When a person opens a PR/MR in a repository whose tasks already came back from homologation, the Studio comments
 * once with the lessons learned there (the Aprendizado categories found in that repository): the checklist reaches
 * whoever is delivering before the test, so the same defect does not send the task back again. The Studio's own
 * agents ("agent/..." branches) already get the lessons in their prompt.
 */
export async function commentLessonsOnOpen(provider: 'GITHUB' | 'GITLAB', payload: Json, workspaceIds: string[], log: FastifyBaseLogger) {
  const opened = openedPullRequest(provider, payload);
  if (!opened || opened.branch.startsWith('agent/')) return;
  if (
    await prisma.studioSetting.findUnique({
      where: { key: sentKey(opened.url) },
    })
  )
    return;
  const remote = parseRemote(opened.repoUrl);
  if (!remote) return;
  const repo = remote.path.split('/').pop()!.toLowerCase();

  for (const workspaceId of workspaceIds) {
    const categories = await prisma.qualityCategory.findMany({
      where: {
        workspaceId,
        status: { not: 'nao_defeito' },
        lesson: { not: null },
        occurrences: {
          some: {
            OR: [
              { taskRef: { startsWith: `${repo}#`, mode: 'insensitive' } },
              { taskRef: { contains: `/${repo}#`, mode: 'insensitive' } }, // "group/repo#N"
            ],
          },
        },
      },
      include: { _count: { select: { occurrences: true } } },
    });
    if (categories.length === 0) continue;
    categories.sort((a, b) => b._count.occurrences - a._count.occurrences);
    const comment = [
      '### Antes do teste em homologação — lições deste repositório',
      '',
      'Defeitos que já fizeram tarefas deste repositório voltarem do teste em HOM. Confira cada um nesta entrega:',
      '',
      ...categories.map((category) => `- [ ] **${category.name}** — ${category.lesson!.trim().replace(/\s+/g, ' ')}`),
      '',
      '_Agents Manager Studio (aba Aprendizado). Comentado uma vez por PR/MR._',
    ].join('\n');
    try {
      const account = await findWorkspaceGitAccount(workspaceId, [remoteHostname(remote), remote.host]);
      await commentPullRequest(
        {
          provider,
          remote,
          token: secrets.decrypt(account.tokenEncrypted),
          number: opened.number,
        },
        comment,
      );
      await prisma.studioSetting.create({
        data: {
          key: sentKey(opened.url),
          value: { at: new Date().toISOString(), lessons: categories.length },
        },
      });
      log.info({ url: opened.url, lessons: categories.length }, 'lições comentadas no PR/MR');
    } catch (error) {
      log.warn({ err: error, url: opened.url }, 'não foi possível comentar as lições no PR/MR');
    }
    return;
  }
}
