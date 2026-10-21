/**
 * docs/roadmap.md of a project: the deliveries ("entregas") in order. Format, kept simple on purpose so agents and
 * people write it the same way:
 *
 *   ## Entrega 1 — Núcleo
 *   **Objetivo:** ...
 *   **Escopo:** ...
 *   **Fora do escopo:** ...
 *   **Critérios de pronto:** ...
 *   **Início:** 2026-10-22          (optional: the plan's dates, local days)
 *   **Prazo:** 2026-10-28
 *   **Tarefas previstas:** 12        (optional: before the tasks exist on the board)
 *   **Dias:**
 *   - 2026-10-22 — Compras no ar: globalfarm#101, gf-novo-oficial#27
 *   - 2026-10-23 — ...
 *
 * Board tasks join a delivery with a line "Entrega: N" in their body. A day lists the tasks that close its goal.
 */

export interface RoadmapDay {
  /** Local day, YYYY-MM-DD. */
  date: string;
  goal: string;
  /** Tasks named in the line ("repo#12", or "#12" for the project's own). */
  refs: string[];
}

export interface RoadmapDelivery {
  number: number;
  name: string;
  objective: string;
  scope: string;
  outOfScope: string;
  doneCriteria: string;
  /** Anything else written under the delivery heading. */
  notes: string;
  start: string | null;
  deadline: string | null;
  estimatedTasks: number | null;
  days: RoadmapDay[];
}

type TextField = 'objective' | 'scope' | 'outOfScope' | 'doneCriteria' | 'notes' | 'startText' | 'deadlineText' | 'estimateText' | 'daysText';
type Draft = Pick<RoadmapDelivery, 'number' | 'name'> & Record<TextField, string>;

const HEADING = /^#{2,3}\s*Entrega\s+(\d+)\s*(?:[—–:-]\s*(.*))?$/i;
const LABELS: Record<string, Exclude<TextField, 'notes'>> = {
  objetivo: 'objective',
  escopo: 'scope',
  'fora do escopo': 'outOfScope',
  'critérios de pronto': 'doneCriteria',
  'criterios de pronto': 'doneCriteria',
  início: 'startText',
  inicio: 'startText',
  prazo: 'deadlineText',
  'tarefas previstas': 'estimateText',
  dias: 'daysText',
};
const LABEL = /^\s*(?:[-*]\s*)?\*\*([^*:]+):?\*\*:?\s*(.*)$/;
const DAY_LINE = /^\s*[-*]\s*\**\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)\**\s*(?:\([^)]*\))?\s*(?:[—–:-]\s*)?(.*)$/;

export function parseRoadmap(markdown: string, year = new Date().getFullYear()): RoadmapDelivery[] {
  const deliveries: Draft[] = [];
  let current: Draft | null = null;
  let field: TextField = 'notes';

  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const heading = HEADING.exec(line.trim());
    if (heading) {
      current = {
        number: Number(heading[1]),
        name: heading[2]?.trim() ?? '',
        objective: '',
        scope: '',
        outOfScope: '',
        doneCriteria: '',
        notes: '',
        startText: '',
        deadlineText: '',
        estimateText: '',
        daysText: '',
      };
      deliveries.push(current);
      field = 'notes';
      continue;
    }
    if (!current) continue;
    // Another section of the same level or above ends the delivery.
    if (/^#{1,2}\s/.test(line)) {
      current = null;
      continue;
    }
    const label = LABEL.exec(line);
    const key = label ? LABELS[label[1]!.trim().toLowerCase()] : undefined;
    if (label && key) {
      field = key;
      current[key] = label[2]!.trim();
      continue;
    }
    // The days list ends at the first line that is not a day (blank lines in between are fine).
    if (field === 'daysText' && line.trim() && !DAY_LINE.test(line)) field = 'notes';
    const text = current[field];
    current[field] = text ? `${text}\n${line}` : line;
  }
  return deliveries
    .map((draft) => ({
      number: draft.number,
      name: draft.name,
      objective: draft.objective.trim(),
      scope: draft.scope.trim(),
      outOfScope: draft.outOfScope.trim(),
      doneCriteria: draft.doneCriteria.trim(),
      notes: draft.notes.trim(),
      start: parseDay(draft.startText, year),
      deadline: parseDay(draft.deadlineText, year),
      estimatedTasks: /\d+/.test(draft.estimateText) ? Number(/\d+/.exec(draft.estimateText)![0]) : null,
      days: parseDays(draft.daysText, year),
    }))
    .sort((a, b) => a.number - b.number);
}

/** "2026-10-22", "22/10" or "22/10/2026" as YYYY-MM-DD; null when it is none of them. */
export function parseDay(text: string, year: number) {
  const value = text.trim().replace(/\*/g, '');
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/.exec(value);
  if (!br) return null;
  return `${br[3] ?? year}-${br[2]!.padStart(2, '0')}-${br[1]!.padStart(2, '0')}`;
}

function parseDays(text: string, year: number): RoadmapDay[] {
  return text.split('\n').flatMap((line) => {
    const match = DAY_LINE.exec(line);
    const date = match ? parseDay(match[1]!, year) : null;
    if (!match || !date) return [];
    const goal = match[2]!.trim();
    const refs = [...goal.matchAll(/(?:^|[\s,(])((?:[\w.-]+\/)*[\w.-]*#\d+)/g)].map((ref) => ref[1]!);
    return [{ date, goal, refs }];
  });
}

/** The delivery a task belongs to, from its "Entrega: N" line; null when it has none. */
export function deliveryOfTask(body: string) {
  const match = /^\s*(?:[-*]\s*)?\**Entrega\**\s*:?\**\s*(\d+)\b/im.exec(body);
  return match ? Number(match[1]) : null;
}

/** The milestone that plans a delivery ("Planejar a Entrega N"); it belongs to that delivery but is not part of the work. */
export function isPlanningTask(title: string) {
  return /planejar a entrega\s+\d+/i.test(title);
}
