import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../db.js';
import { parseTrigger, startManualRun } from './engine.js';

/**
 * Manual workflows with a schedule (e.g. the weekly roadmap review): on each chosen weekday, once the time has come,
 * the Studio starts a run with the schedule's message. A run of the workflow started since that time (by the schedule
 * or by hand) counts, so a restart never starts it twice and a day the server was down catches up later that day.
 */
const TIME_ZONE = 'America/Sao_Paulo';

/** Local weekday, day and minutes of an instant. */
function localNow(at: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Whether a schedule is due now, and since when (the instant of today's time). */
export function dueSince(schedule: { weekdays: number[]; at: string }, now: number) {
  const local = localNow(now);
  const [hours, minutes] = schedule.at.split(':').map(Number);
  const target = hours! * 60 + minutes!;
  if (!schedule.weekdays.includes(local.weekday) || local.minutes < target) return null;
  return new Date(now - (local.minutes - target) * 60_000 - (now % 60_000));
}

export async function runSchedules(log: FastifyBaseLogger) {
  const workflows = await prisma.workflow.findMany({ where: { isEnabled: true, workspace: { isIgnored: false, missingAt: null } } });
  for (const workflow of workflows) {
    const trigger = parseTrigger(workflow);
    if (trigger.type !== 'manual' || !trigger.schedule) continue;
    const since = dueSince(trigger.schedule, Date.now());
    if (!since) continue;
    const started = await prisma.workflowRun.count({ where: { workflowId: workflow.id, startedAt: { gte: since } } });
    if (started > 0) continue;
    log.info({ workflowId: workflow.id, name: workflow.name }, 'Starting a scheduled workflow');
    await startManualRun(workflow, trigger.schedule.message, log).catch((err) => log.warn({ err, workflowId: workflow.id }, 'Scheduled workflow failed to start'));
  }
}
