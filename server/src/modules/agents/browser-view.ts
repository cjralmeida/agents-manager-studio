import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * "Navegador ao vivo": the pages open in the browsers an agent drives with Playwright, and their latest frame, for the
 * agent's page in the Studio. The runner reports the open pages every couple of seconds and, only while someone is
 * watching, sends a frame of each (Chromium's screencast). Nothing is stored: it lives in memory, a few frames per agent.
 */

const LIVE_MS = 8_000;
const WATCH_MS = 12_000;
const MAX_PAGES = 4;

export const browserReport = z
  .object({
    pages: z.array(z.object({ id: z.string().min(1).max(100), url: z.string().max(2000), title: z.string().max(300) }).strict()).max(20),
    frames: z
      .array(z.object({ pageId: z.string().min(1).max(100), data: z.string().max(3_000_000) }).strict())
      .max(MAX_PAGES)
      .default([]),
  })
  .strict();

type Page = { id: string; url: string; title: string };
interface View {
  pages: Page[];
  reportedAt: number;
  watchedUntil: number;
  frames: Map<string, { data: Buffer; at: number }>;
}

const views = new Map<string, View>();

const viewOf = (agentId: string) => {
  let view = views.get(agentId);
  if (!view) {
    view = { pages: [], reportedAt: 0, watchedUntil: 0, frames: new Map() };
    views.set(agentId, view);
  }
  return view;
};

/** The runner's report: the open pages and, while watched, their frames. Answers whether someone is watching. */
export function reportBrowser(agentId: string, report: z.infer<typeof browserReport>) {
  const view = viewOf(agentId);
  const now = Date.now();
  view.pages = report.pages.slice(0, MAX_PAGES);
  view.reportedAt = now;
  for (const frame of report.frames) view.frames.set(frame.pageId, { data: Buffer.from(frame.data, 'base64'), at: now });
  for (const id of view.frames.keys()) if (!view.pages.some((page) => page.id === id)) view.frames.delete(id);
  if (view.pages.length === 0 && now > view.watchedUntil) views.delete(agentId);
  return { watching: now < view.watchedUntil };
}

/** What the agent's page shows; asking for it counts as watching, so the runner starts sending frames. */
export function watchBrowser(agentId: string) {
  const view = viewOf(agentId);
  const now = Date.now();
  view.watchedUntil = now + WATCH_MS;
  const live = now - view.reportedAt < LIVE_MS;
  return {
    live: live && view.pages.length > 0,
    pages: live ? view.pages.map((page) => ({ ...page, frameAt: view.frames.get(page.id)?.at ?? null })) : [],
  };
}

export function browserFrame(agentId: string, pageId: string) {
  return views.get(agentId)?.frames.get(pageId)?.data ?? null;
}

// ---------------------------------------------------------------- failures of the last test run

export interface TestFailure {
  /** Playwright's folder of the failed test (its name says the spec, the test and the browser). */
  name: string;
  at: string;
  screenshots: string[];
  trace: string | null;
  video: string | null;
}

const SKIP = new Set(['node_modules', '.git', '.venv', 'dist', 'build', 'target']);

/**
 * The failures Playwright kept in the agent's copy (screenshot, trace and video of each failed test, in the
 * test-results folders): the last run of each suite, since Playwright clears the folder when a run starts.
 * Paths are relative to the copy, for /agents/:id/files.
 */
export async function testFailures(root: string): Promise<TestFailure[]> {
  const folders = await findResults(root, 0);
  const failures: TestFailure[] = [];
  for (const folder of folders) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.posix.join(folder, entry.name);
      const files = await readdir(dir).catch(() => [] as string[]);
      const screenshots = files.filter((file) => file.endsWith('.png'));
      const trace = files.find((file) => file === 'trace.zip') ?? null;
      const video = files.find((file) => file.endsWith('.webm')) ?? null;
      if (screenshots.length === 0 && !trace) continue;
      const at = (await stat(dir).catch(() => null))?.mtime ?? new Date(0);
      const relative = (file: string) => path.posix.relative(root, path.posix.join(dir, file));
      failures.push({ name: entry.name, at: at.toISOString(), screenshots: screenshots.map(relative), trace: trace && relative(trace), video: video && relative(video) });
    }
  }
  return failures.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
}

async function findResults(dir: string, depth: number): Promise<string[]> {
  if (depth > 4) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const child = path.posix.join(dir, entry.name);
    if (entry.name === 'test-results') found.push(child);
    else found.push(...(await findResults(child, depth + 1)));
  }
  return found;
}
