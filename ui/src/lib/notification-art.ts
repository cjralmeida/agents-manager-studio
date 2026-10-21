/**
 * Pictures of the browser notifications, drawn on a canvas: the medal of the outcome (the notification's icon) and a
 * card with the details (the large image Chrome shows under the text). Both are data URLs, so nothing is fetched.
 */

export type Glyph = 'check' | 'cross' | 'question' | 'bang' | 'rocket' | 'eye';

export interface Medal {
  /** What happened, in a word or two ("Aprovada", "Publicada em HOM"). */
  label: string;
  color: string;
  glyph: Glyph;
}

export interface CardDetails {
  medal: Medal;
  /** The workflow step or kind of work ("Revisar", "Publicar em homologação"). */
  step: string | null;
  taskRef: string | null;
  title: string;
  summary: string | null;
  /** Workspace, duration, cost... shown at the bottom. */
  facts: string[];
}

const FONT = '"Segoe UI", system-ui, sans-serif';
const BACKGROUND = '#0f1115';
const PANEL = '#171a21';
const TEXT = '#e7e9ee';
const MUTED = '#9aa1ad';

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return { element, context: element.getContext('2d')! };
}

/** Lighter or darker shade of a #rrggbb color (amount from -1 to 1). */
function shade(hex: string, amount: number) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const base = (value >> shift) & 255;
    const target = amount < 0 ? 0 : 255;
    return Math.round(base + (target - base) * Math.abs(amount));
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function drawGlyph(context: CanvasRenderingContext2D, glyph: Glyph, x: number, y: number, size: number) {
  context.save();
  context.translate(x, y);
  context.strokeStyle = '#ffffff';
  context.fillStyle = '#ffffff';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = size * 0.16;
  const s = size / 2;
  context.beginPath();
  switch (glyph) {
    case 'check':
      context.moveTo(-s * 0.55, 0);
      context.lineTo(-s * 0.12, s * 0.45);
      context.lineTo(s * 0.6, -s * 0.4);
      context.stroke();
      break;
    case 'cross':
      context.moveTo(-s * 0.45, -s * 0.45);
      context.lineTo(s * 0.45, s * 0.45);
      context.moveTo(s * 0.45, -s * 0.45);
      context.lineTo(-s * 0.45, s * 0.45);
      context.stroke();
      break;
    case 'eye':
      context.lineWidth = size * 0.11;
      context.moveTo(-s * 0.75, 0);
      context.quadraticCurveTo(0, -s * 0.75, s * 0.75, 0);
      context.quadraticCurveTo(0, s * 0.75, -s * 0.75, 0);
      context.stroke();
      context.beginPath();
      context.arc(0, 0, s * 0.22, 0, Math.PI * 2);
      context.fill();
      break;
    case 'rocket':
      // A rocket pointing up and right: body, window and flame.
      context.rotate(Math.PI / 4);
      context.scale(1.45, 1.45);
      context.moveTo(0, -s * 0.8);
      context.quadraticCurveTo(s * 0.38, -s * 0.35, s * 0.28, s * 0.35);
      context.lineTo(-s * 0.28, s * 0.35);
      context.quadraticCurveTo(-s * 0.38, -s * 0.35, 0, -s * 0.8);
      context.fill();
      context.beginPath();
      context.moveTo(-s * 0.28, s * 0.1);
      context.lineTo(-s * 0.5, s * 0.5);
      context.lineTo(-s * 0.2, s * 0.35);
      context.moveTo(s * 0.28, s * 0.1);
      context.lineTo(s * 0.5, s * 0.5);
      context.lineTo(s * 0.2, s * 0.35);
      context.fill();
      context.beginPath();
      context.fillStyle = 'rgba(0, 0, 0, 0.35)';
      context.arc(0, -s * 0.2, s * 0.14, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.fillStyle = '#fde68a';
      context.moveTo(-s * 0.16, s * 0.42);
      context.quadraticCurveTo(0, s * 0.95, s * 0.16, s * 0.42);
      context.fill();
      break;
    case 'question':
    case 'bang':
      context.font = `800 ${size * 0.95}px ${FONT}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(glyph === 'question' ? '?' : '!', 0, size * 0.04);
      break;
  }
  context.restore();
}

/** A medal: two ribbon tails behind a disc with a bevelled rim and the glyph. */
function drawMedal(context: CanvasRenderingContext2D, medal: Medal, x: number, y: number, radius: number) {
  const tail = (direction: number) => {
    context.beginPath();
    context.moveTo(x + direction * radius * 0.2, y);
    context.lineTo(x + direction * radius * 0.85, y + radius * 1.55);
    context.lineTo(x + direction * radius * 0.5, y + radius * 1.35);
    context.lineTo(x + direction * radius * 0.25, y + radius * 1.6);
    context.lineTo(x - direction * radius * 0.2, y + radius * 0.4);
    context.closePath();
    context.fill();
  };
  context.fillStyle = shade(medal.color, -0.35);
  tail(-1);
  context.fillStyle = shade(medal.color, -0.2);
  tail(1);

  const rim = context.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
  rim.addColorStop(0, shade(medal.color, 0.45));
  rim.addColorStop(1, shade(medal.color, -0.3));
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = rim;
  context.fill();

  const face = context.createRadialGradient(x - radius * 0.3, y - radius * 0.35, radius * 0.1, x, y, radius * 0.82);
  face.addColorStop(0, shade(medal.color, 0.25));
  face.addColorStop(1, medal.color);
  context.beginPath();
  context.arc(x, y, radius * 0.8, 0, Math.PI * 2);
  context.fillStyle = face;
  context.fill();
  context.lineWidth = radius * 0.05;
  context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  context.stroke();

  drawGlyph(context, medal.glyph, x, y, radius * 0.9);
}

/** The notification's icon: the medal alone, on transparent background. */
export function medalIcon(medal: Medal) {
  const { element, context } = canvas(192, 192);
  drawMedal(context, medal, 96, 74, 62);
  return element.toDataURL('image/png');
}

/** Breaks a text into at most `maxLines` lines that fit `width`, the last one ending in "…" when cut. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines && lines.every((entry) => context.measureText(entry).width <= width)) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[kept.length - 1] ?? '';
  while (last && context.measureText(`${last}…`).width > width) last = last.slice(0, -1);
  kept[kept.length - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** The card under the notification's text: medal, verdict, task, summary and the facts of the run. */
export function detailsCard(details: CardDetails) {
  const width = 720;
  const height = 360;
  const { element, context } = canvas(width, height);
  const { medal } = details;

  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(110, 150, 10, 110, 150, 320);
  glow.addColorStop(0, `${medal.color}55`);
  glow.addColorStop(1, `${medal.color}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  context.fillStyle = medal.color;
  context.fillRect(0, 0, width, 6);

  drawMedal(context, medal, 115, 140, 72);

  const left = 230;
  const textWidth = width - left - 32;
  context.textBaseline = 'alphabetic';
  context.fillStyle = medal.color;
  context.font = `700 40px ${FONT}`;
  context.fillText(medal.label, left, 78);

  let y = 116;
  const meta = [details.step, details.taskRef].filter(Boolean).join('  ·  ');
  if (meta) {
    context.fillStyle = MUTED;
    context.font = `600 20px ${FONT}`;
    context.fillText(wrap(context, meta, textWidth, 1)[0] ?? meta, left, y);
    y += 38;
  }
  context.fillStyle = TEXT;
  context.font = `600 25px ${FONT}`;
  for (const line of wrap(context, details.title, textWidth, 2)) {
    context.fillText(line, left, y);
    y += 33;
  }
  if (details.summary) {
    y += 6;
    context.fillStyle = MUTED;
    context.font = `400 20px ${FONT}`;
    for (const line of wrap(context, details.summary, textWidth, height - y > 110 ? 3 : 2)) {
      context.fillText(line, left, y);
      y += 27;
    }
  }

  if (details.facts.length > 0) {
    const barTop = height - 58;
    context.fillStyle = PANEL;
    context.fillRect(0, barTop, width, 58);
    context.font = `600 19px ${FONT}`;
    let x = 32;
    for (const fact of details.facts) {
      const factWidth = context.measureText(fact).width;
      if (x + factWidth > width - 24) break;
      context.fillStyle = medal.color;
      context.beginPath();
      context.arc(x + 5, barTop + 29, 5, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = TEXT;
      context.fillText(fact, x + 18, barTop + 36);
      x += factWidth + 48;
    }
  }
  return element.toDataURL('image/png');
}
