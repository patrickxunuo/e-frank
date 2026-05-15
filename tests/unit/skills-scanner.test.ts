import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  parseSkillFrontmatter,
  scanInstalledSkills,
  type SkillsScannerFs,
} from '../../src/main/modules/skills-scanner';

/**
 * SkillsScanner tests — driven by an in-memory `SkillsScannerFs` so no
 * real filesystem state is needed. Paths in the in-memory map are built
 * via `path.join` (just like the scanner does) so the tests work on both
 * POSIX and Windows path separators.
 */

interface InMemoryNode {
  isDirectory: boolean;
  content?: string;
}

class InMemoryFs implements SkillsScannerFs {
  constructor(private readonly nodes: Map<string, InMemoryNode>) {}

  async readdir(path: string): Promise<string[]> {
    const exists = this.nodes.has(path);
    const children = new Set<string>();
    for (const key of this.nodes.keys()) {
      // Match either separator — test entries are normalized via path.join
      // but we want to be resilient to mixed slashes.
      const rest = stripPrefix(key, path);
      if (rest === null) continue;
      const first = rest.split(/[\\/]/)[0];
      if (first !== undefined && first !== '') children.add(first);
    }
    if (!exists && children.size === 0) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return Array.from(children);
  }

  async readFile(path: string, _encoding: 'utf8'): Promise<string> {
    const node = this.nodes.get(path);
    if (node === undefined || node.content === undefined) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return node.content;
  }

  async stat(path: string): Promise<{ isDirectory(): boolean }> {
    const node = this.nodes.get(path);
    if (node === undefined) {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return { isDirectory: () => node.isDirectory };
  }
}

/**
 * Returns the path tail when `key` lives under `parent`, or null when it
 * doesn't. Treats `\` and `/` as equivalent so a test can author entries
 * with one separator and have the scanner request via the other (which
 * happens when `path.join` runs on Windows but the test uses POSIX paths).
 */
function stripPrefix(key: string, parent: string): string | null {
  const normParent = parent.replace(/[\\/]+$/, '');
  const normKey = key;
  const prefixA = normParent + '/';
  const prefixB = normParent + '\\';
  if (normKey.startsWith(prefixA)) return normKey.slice(prefixA.length);
  if (normKey.startsWith(prefixB)) return normKey.slice(prefixB.length);
  return null;
}

function makeFs(roots: Record<string, { isDirectory: true } | { content: string }>): InMemoryFs {
  const m = new Map<string, InMemoryNode>();
  for (const [k, v] of Object.entries(roots)) {
    if ('content' in v) {
      m.set(k, { isDirectory: false, content: v.content });
    } else {
      m.set(k, { isDirectory: true });
    }
  }
  return new InMemoryFs(m);
}

const USER_ROOT = join('/home', '.claude', 'skills');
const PROJECT_ROOT = join('/cwd', '.claude', 'skills');

describe('parseSkillFrontmatter', () => {
  it('SCAN-PARSE-001: parses simple key:value pairs', () => {
    const md =
      '---\nname: my-skill\ndescription: Does a thing\n---\n\n# Heading\nbody';
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
    });
  });

  it('SCAN-PARSE-002: returns empty object when no frontmatter block', () => {
    expect(parseSkillFrontmatter('# Heading\njust body, no fm')).toEqual({});
  });

  it('SCAN-PARSE-003: returns empty object when frontmatter is unterminated', () => {
    expect(parseSkillFrontmatter('---\nname: my-skill\nbody-no-closer')).toEqual({});
  });

  it('SCAN-PARSE-004: unwraps single- and double-quoted values', () => {
    const md = "---\nname: \"my-skill\"\ndescription: 'has: colon and spaces'\n---\n";
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'my-skill',
      description: 'has: colon and spaces',
    });
  });

  it('SCAN-PARSE-005: tolerates CRLF line endings', () => {
    const md = '---\r\nname: win-skill\r\ndescription: desc\r\n---\r\n';
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'win-skill',
      description: 'desc',
    });
  });

  it('SCAN-PARSE-006: skips comment lines and blank lines inside fm', () => {
    const md = '---\n# comment\nname: x\n\ndescription: y\n---\n';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'x', description: 'y' });
  });
});

describe('scanInstalledSkills', () => {
  it('SCAN-001: returns user-level skills with parsed frontmatter', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'foo')]: { isDirectory: true },
      [join(USER_ROOT, 'foo', 'SKILL.md')]: {
        content: '---\nname: Foo\ndescription: Foo desc\n---\nbody',
      },
      [join(USER_ROOT, 'bar')]: { isDirectory: true },
      [join(USER_ROOT, 'bar', 'SKILL.md')]: {
        content: '---\nname: Bar\ndescription: Bar desc\n---\n',
      },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills.map((s) => s.id).sort()).toEqual(['bar', 'foo']);
    const bar = skills.find((s) => s.id === 'bar');
    expect(bar).toMatchObject({
      id: 'bar',
      name: 'Bar',
      description: 'Bar desc',
      source: 'user',
      dirPath: join(USER_ROOT, 'bar'),
      skillMdPath: join(USER_ROOT, 'bar', 'SKILL.md'),
    });
  });

  it('SCAN-002: returns empty array when user root does not exist', async () => {
    const fs = makeFs({});
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills).toEqual([]);
  });

  it('SCAN-003: project entries override user entries with same id', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'foo')]: { isDirectory: true },
      [join(USER_ROOT, 'foo', 'SKILL.md')]: {
        content: '---\nname: Foo-User\ndescription: from user\n---\n',
      },
      [join(PROJECT_ROOT, 'foo')]: { isDirectory: true },
      [join(PROJECT_ROOT, 'foo', 'SKILL.md')]: {
        content: '---\nname: Foo-Project\ndescription: from project\n---\n',
      },
    });
    const skills = await scanInstalledSkills({
      userRoot: USER_ROOT,
      projectRoot: PROJECT_ROOT,
      fs,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: 'foo',
      name: 'Foo-Project',
      source: 'project',
    });
  });

  it('SCAN-004: falls back to id when SKILL.md has no name field', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'nameless')]: { isDirectory: true },
      [join(USER_ROOT, 'nameless', 'SKILL.md')]: {
        content: '# just markdown, no frontmatter',
      },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills[0]).toMatchObject({
      id: 'nameless',
      name: 'nameless',
      description: '',
    });
  });

  it('SCAN-005: skips directories without a SKILL.md', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'no-skill-md')]: { isDirectory: true },
      [join(USER_ROOT, 'with-skill-md')]: { isDirectory: true },
      [join(USER_ROOT, 'with-skill-md', 'SKILL.md')]: {
        content: '---\nname: ok\n---\n',
      },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills.map((s) => s.id)).toEqual(['with-skill-md']);
  });

  it('SCAN-006: skips hidden dotfile entries at the root', async () => {
    const fs = makeFs({
      [join(USER_ROOT, '.cache')]: { isDirectory: true },
      [join(USER_ROOT, 'visible')]: { isDirectory: true },
      [join(USER_ROOT, 'visible', 'SKILL.md')]: {
        content: '---\nname: visible\n---\n',
      },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills.map((s) => s.id)).toEqual(['visible']);
  });

  it('SCAN-007: sorts results alphabetically (case-insensitive) by name', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'a')]: { isDirectory: true },
      [join(USER_ROOT, 'a', 'SKILL.md')]: { content: '---\nname: zebra\n---\n' },
      [join(USER_ROOT, 'b')]: { isDirectory: true },
      [join(USER_ROOT, 'b', 'SKILL.md')]: { content: '---\nname: apple\n---\n' },
      [join(USER_ROOT, 'c')]: { isDirectory: true },
      [join(USER_ROOT, 'c', 'SKILL.md')]: { content: '---\nname: Banana\n---\n' },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills.map((s) => s.name)).toEqual(['apple', 'Banana', 'zebra']);
  });

  it('SCAN-008: project-only scan works without a user root present on disk', async () => {
    const fs = makeFs({
      [join(PROJECT_ROOT, 'only-project')]: { isDirectory: true },
      [join(PROJECT_ROOT, 'only-project', 'SKILL.md')]: {
        content: '---\nname: Only Project\n---\n',
      },
    });
    const skills = await scanInstalledSkills({
      userRoot: join('/nope', '.claude', 'skills'),
      projectRoot: PROJECT_ROOT,
      fs,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.source).toBe('project');
  });

  it('SCAN-009: sourceLookup injects sourceRepo onto matching skills; missing entries get null (#GH-93)', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'tracked')]: { isDirectory: true },
      [join(USER_ROOT, 'tracked', 'SKILL.md')]: {
        content: '---\nname: Tracked\n---\n',
      },
      [join(USER_ROOT, 'untracked')]: { isDirectory: true },
      [join(USER_ROOT, 'untracked', 'SKILL.md')]: {
        content: '---\nname: Untracked\n---\n',
      },
    });
    const skills = await scanInstalledSkills({
      userRoot: USER_ROOT,
      fs,
      sourceLookup: { tracked: 'vercel-labs/agent-skills' },
    });
    const tracked = skills.find((s) => s.id === 'tracked');
    const untracked = skills.find((s) => s.id === 'untracked');
    expect(tracked?.sourceRepo).toBe('vercel-labs/agent-skills');
    expect(untracked?.sourceRepo).toBeNull();
  });

  it('SCAN-010: omitting sourceLookup defaults every sourceRepo to null (pre-tracker baseline)', async () => {
    const fs = makeFs({
      [join(USER_ROOT, 'foo')]: { isDirectory: true },
      [join(USER_ROOT, 'foo', 'SKILL.md')]: {
        content: '---\nname: Foo\n---\n',
      },
    });
    const skills = await scanInstalledSkills({ userRoot: USER_ROOT, fs });
    expect(skills[0]?.sourceRepo).toBeNull();
  });
});
