import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { parseSkillFrontmatter } from './frontmatter.js';

/** PERSONAL: ~/.claude/skills/<name>. ACCOUNT: synced from the claude.ai account (~/.claude/skills/synced/<bucket>/<name>). */
export type SkillSource = 'PERSONAL' | 'ACCOUNT';

export interface Skill {
  /** Folder path relative to the skills root; stable identifier used in workspace settings. */
  id: string;
  name: string;
  description: string;
  source: SkillSource;
}

const SYNCED_DIR = 'synced';
const sourceOrder: Record<SkillSource, number> = { PERSONAL: 0, ACCOUNT: 1 };

export async function listSkills(rootDir = config.skillsDir): Promise<Skill[]> {
  const personal = (await listSubdirectories(rootDir)).filter((name) => name !== SYNCED_DIR);
  const buckets = await listSubdirectories(path.join(rootDir, SYNCED_DIR));
  const synced = (
    await Promise.all(
      buckets.map(async (bucket) =>
        (await listSubdirectories(path.join(rootDir, SYNCED_DIR, bucket))).map((name) =>
          path.posix.join(SYNCED_DIR, bucket, name),
        ),
      ),
    )
  ).flat();

  const skills = await Promise.all([
    ...personal.map((id) => readSkill(rootDir, id, 'PERSONAL')),
    ...synced.map((id) => readSkill(rootDir, id, 'ACCOUNT')),
  ]);

  return skills
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || a.name.localeCompare(b.name));
}

async function readSkill(rootDir: string, id: string, source: SkillSource): Promise<Skill | null> {
  const content = await readFile(path.join(rootDir, id, 'SKILL.md'), 'utf8').catch(() => null);
  if (content === null) return null;

  const metadata = parseSkillFrontmatter(content);
  return {
    id,
    name: metadata.name ?? path.posix.basename(id),
    description: metadata.description ?? '',
    source,
  };
}

/** Missing folders yield an empty list: the skills mount is optional. */
async function listSubdirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
}
