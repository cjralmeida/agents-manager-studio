export interface SkillMetadata {
  name?: string;
  description?: string;
}

/**
 * Reads `name` and `description` from the YAML frontmatter of a SKILL.md.
 * Supports plain, quoted and block (`>` / `|`) values, which covers how skills are written.
 */
export function parseSkillFrontmatter(content: string): SkillMetadata {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  const body = lines.slice(1, end === -1 ? undefined : end);
  const metadata: SkillMetadata = {};

  for (let index = 0; index < body.length; index++) {
    const match = /^(name|description):\s*(.*)$/.exec(body[index] ?? '');
    if (!match) continue;

    const key = match[1] as keyof SkillMetadata;
    let value = (match[2] ?? '').trim();

    if (/^[>|][+-]?$/.test(value)) {
      const blockLines: string[] = [];
      while (index + 1 < body.length && /^\s+\S/.test(body[index + 1] ?? '')) {
        blockLines.push((body[++index] ?? '').trim());
      }
      value = blockLines.join(' ');
    }

    metadata[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }

  return metadata;
}
