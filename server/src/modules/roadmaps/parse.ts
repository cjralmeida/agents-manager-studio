/**
 * docs/roadmap.md of a project: the deliveries ("entregas") in order. Format, kept simple on purpose so agents and
 * people write it the same way:
 *
 *   ## Entrega 1 — Núcleo
 *   **Objetivo:** ...
 *   **Escopo:** ...
 *   **Fora do escopo:** ...
 *   **Critérios de pronto:** ...
 *
 * Board tasks join a delivery with a line "Entrega: N" in their body.
 */

export interface RoadmapDelivery {
  number: number;
  name: string;
  objective: string;
  scope: string;
  outOfScope: string;
  doneCriteria: string;
  /** Anything else written under the delivery heading. */
  notes: string;
}

const HEADING = /^#{2,3}\s*Entrega\s+(\d+)\s*(?:[—–:-]\s*(.*))?$/i;
const LABELS: Record<string, keyof Pick<RoadmapDelivery, 'objective' | 'scope' | 'outOfScope' | 'doneCriteria'>> = {
  objetivo: 'objective',
  escopo: 'scope',
  'fora do escopo': 'outOfScope',
  'critérios de pronto': 'doneCriteria',
  'criterios de pronto': 'doneCriteria',
};
const LABEL = /^\s*(?:[-*]\s*)?\*\*([^*:]+):?\*\*:?\s*(.*)$/;

export function parseRoadmap(markdown: string): RoadmapDelivery[] {
  const deliveries: RoadmapDelivery[] = [];
  let current: RoadmapDelivery | null = null;
  let field: keyof RoadmapDelivery | 'notes' = 'notes';

  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const heading = HEADING.exec(line.trim());
    if (heading) {
      current = { number: Number(heading[1]), name: heading[2]?.trim() ?? '', objective: '', scope: '', outOfScope: '', doneCriteria: '', notes: '' };
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
    const text = current[field] as string;
    (current[field] as string) = text ? `${text}\n${line}` : line;
  }
  for (const delivery of deliveries) {
    for (const key of ['objective', 'scope', 'outOfScope', 'doneCriteria', 'notes'] as const) delivery[key] = delivery[key].trim();
  }
  return deliveries.sort((a, b) => a.number - b.number);
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
