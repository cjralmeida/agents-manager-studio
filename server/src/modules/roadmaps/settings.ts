import { z } from 'zod';
import { prisma } from '../../db.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { ALL_DAY, type Interval, type WorkCalendar } from './calendar.js';

/**
 * How a workspace's roadmap counts time: its working calendar, how long a stretch without any work must be to count
 * as a pause on its own, and the pauses marked by hand (e.g. days spent fixing the Studio while agents still ran).
 */
const key = (workspaceId: string) => `roadmap:settings:${workspaceId}`;

const time = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/);

export const roadmapSettingsSchema = z
  .object({
    calendar: z
      .object({
        timeZone: z.string().min(1).max(60),
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: time,
        end: time,
      })
      .strict()
      .refine((calendar) => calendar.start < calendar.end, { message: 'O fim do expediente deve ser depois do início.' }),
    /** Working hours without any agent or run that count as a pause by themselves. */
    autoPauseHours: z.number().min(1).max(72),
    pauses: z
      .array(
        z
          .object({
            from: z.iso.datetime({ offset: true }),
            to: z.iso.datetime({ offset: true }),
            reason: z.string().trim().max(200).default(''),
          })
          .strict()
          .refine((pause) => Date.parse(pause.to) > Date.parse(pause.from), { message: 'A pausa termina antes de começar.' }),
      )
      .max(200),
  })
  .strict();

export type RoadmapSettings = z.infer<typeof roadmapSettingsSchema>;

const DEFAULTS: RoadmapSettings = { calendar: { timeZone: 'America/Sao_Paulo', ...ALL_DAY }, autoPauseHours: 3, pauses: [] };

export async function roadmapSettings(workspaceId: string): Promise<RoadmapSettings> {
  const row = await prisma.studioSetting.findUnique({ where: { key: key(workspaceId) } });
  const parsed = roadmapSettingsSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : DEFAULTS;
}

export async function saveRoadmapSettings(workspaceId: string, input: RoadmapSettings) {
  const value = input as unknown as Prisma.InputJsonValue;
  await prisma.studioSetting.upsert({ where: { key: key(workspaceId) }, create: { key: key(workspaceId), value }, update: { value } });
  return input;
}

export const calendarOf = (settings: RoadmapSettings): WorkCalendar => settings.calendar;
export const manualPauses = (settings: RoadmapSettings): Interval[] => settings.pauses.map((pause) => ({ from: Date.parse(pause.from), to: Date.parse(pause.to) }));
