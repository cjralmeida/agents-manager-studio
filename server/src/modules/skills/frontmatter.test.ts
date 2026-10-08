import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSkillFrontmatter } from './frontmatter.js';

describe('parseSkillFrontmatter', () => {
  it('reads plain values', () => {
    const content = '---\nname: backend-standards\ndescription: Padrão de backend.\n---\n\n# Body\nname: ignored';
    assert.deepEqual(parseSkillFrontmatter(content), {
      name: 'backend-standards',
      description: 'Padrão de backend.',
    });
  });

  it('unquotes quoted values and handles CRLF', () => {
    const content = '---\r\nname: "docs"\r\ndescription: \'Edit docs\'\r\n---\r\n';
    assert.deepEqual(parseSkillFrontmatter(content), { name: 'docs', description: 'Edit docs' });
  });

  it('joins block values', () => {
    const content = '---\nname: pdf\ndescription: >\n  Use for PDFs.\n  Also forms.\nlicense: MIT\n---\n';
    assert.deepEqual(parseSkillFrontmatter(content), { name: 'pdf', description: 'Use for PDFs. Also forms.' });
  });

  it('returns nothing without frontmatter', () => {
    assert.deepEqual(parseSkillFrontmatter('# Just markdown'), {});
  });
});
