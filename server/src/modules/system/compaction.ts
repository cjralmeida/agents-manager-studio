import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { HttpError } from '../../lib/errors.js';
import { ownerWorkspaces, pauseWorkspace, resumeWorkspace } from '../orbi/ops.js';
import { getHostHelper, readJson, writeJson } from '../studio-settings/host-helper.js';
import { runDiskMaintenance } from './maintenance.js';

/**
 * Compacting Docker's disk file, on the user's request. Docker has to stop, so the Studio (which runs in it) asks the
 * Windows helper: it stops Docker, runs diskpart as administrator, starts Docker and the Studio again and shows the
 * progress on its own page meanwhile. Before, the Studio pauses every workspace (workflows off, agents stopped) and
 * cleans up; once it is back and the compaction ended, it resumes what it paused.
 */

const KEY = 'diskCompaction';
const STATUS_PAGE = 'http://localhost:8790';
const TICK_MS = 60_000;

interface CompactionRequest {
  id: string;
  ownerId: string;
  workspaceIds: string[];
  requestedAt: string;
  resumePending: boolean;
  resumedAt: string | null;
}

/** What the helper writes while it works (host-helper/compaction.json). */
export interface HelperCompaction {
  id: string;
  status: 'running' | 'done' | 'error';
  step: 'starting' | 'stopping_docker' | 'compacting' | 'starting_docker' | 'starting_studio' | 'finished';
  percent: number | null;
  sizeBefore: number | null;
  sizeAfter: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

async function request() {
  const row = await prisma.studioSetting.findUnique({ where: { key: KEY } });
  return (row?.value as unknown as CompactionRequest | undefined) ?? null;
}

async function saveRequest(value: CompactionRequest) {
  const json = value as unknown as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } });
}

export async function compactionStatus() {
  const [current, helper, hostHelper] = await Promise.all([request(), readJson<HelperCompaction>('compaction.json'), getHostHelper()]);
  const run = helper && current && helper.id === current.id ? helper : null;
  return {
    helperOnline: hostHelper.online,
    installCommand: hostHelper.installCommand,
    statusPage: STATUS_PAGE,
    request: current,
    run,
    // While it runs the Studio is about to stop (or is coming back): the helper's page follows it.
    running: Boolean(run && run.status === 'running') || Boolean(current && current.resumePending && !run),
  };
}

/** Pauses everything, cleans up and asks the helper to compact. */
export async function startCompaction(ownerId: string, log?: FastifyBaseLogger) {
  const status = await compactionStatus();
  if (!status.helperOnline) throw new HttpError(409, 'O helper do Windows não está rodando: a compressão precisa dele (ele desliga e religa o Docker).');
  if (status.running) throw new HttpError(409, 'Já há uma compressão em andamento.');

  const workspaces = await ownerWorkspaces(ownerId);
  const caller = { ownerId, conversationId: null };
  for (const workspace of workspaces) {
    await pauseWorkspace(caller, { workspace: workspace.id, stopAgents: true, reason: 'Compressão do disco do Docker' }).catch((err: unknown) =>
      log?.warn({ err, workspace: workspace.name }, 'Could not pause the workspace for the compaction'),
    );
  }
  // Less to compact: the build cache and orphan images go, and the free blocks are trimmed.
  await runDiskMaintenance(log).catch(() => null);

  const id = randomUUID();
  await saveRequest({ id, ownerId, workspaceIds: workspaces.map((workspace) => workspace.id), requestedAt: new Date().toISOString(), resumePending: true, resumedAt: null });
  await writeJson('request.json', { type: 'compact-docker', id });
  log?.info({ id }, 'Disk compaction requested');
  return compactionStatus();
}

/** Back from a compaction that ended (done or error): resumes the workspaces it paused. */
async function resumeAfterCompaction(log: FastifyBaseLogger) {
  const current = await request();
  if (!current?.resumePending) return;
  const helper = await readJson<HelperCompaction>('compaction.json');
  if (!helper || helper.id !== current.id || helper.status === 'running') return;
  const caller = { ownerId: current.ownerId, conversationId: null };
  for (const workspaceId of current.workspaceIds) {
    await resumeWorkspace(caller, { workspace: workspaceId, reason: 'Fim da compressão do disco do Docker' }).catch(() => undefined);
  }
  await saveRequest({ ...current, resumePending: false, resumedAt: new Date().toISOString() });
  log.info({ id: current.id, status: helper.status }, 'Resumed after the disk compaction');
}

export function startCompactionWatch(log: FastifyBaseLogger) {
  const tick = () => void resumeAfterCompaction(log).catch((err: unknown) => log.warn({ err }, 'Resume after compaction failed'));
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
