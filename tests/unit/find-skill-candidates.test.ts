import { describe, expect, it } from 'vitest';
import { parseSkillCandidates } from '../../src/renderer/components/find-skill-candidates';

/**
 * CANDIDATE-PARSE-001..010 — robustness of the JSON-array extractor that
 * pulls structured skill candidates out of Claude's streamed
 * `/find-skills` response.
 *
 * The parser has to survive Claude's stylistic variation: clean JSON,
 * fenced JSON, JSON wrapped in prose, malformed JSON, no JSON at all,
 * etc. The dialog falls back to the raw-stream + manual-install view
 * when `parsed: false`.
 */

describe('parseSkillCandidates', () => {
  it('CANDIDATE-PARSE-001: parses a clean JSON array', () => {
    const out = '[{"name":"ef-feature","ref":"ef-feature","description":"Ticket-to-PR","stars":42}]';
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates).toEqual([
      { name: 'ef-feature', ref: 'ef-feature', description: 'Ticket-to-PR', stars: 42 },
    ]);
  });

  it('CANDIDATE-PARSE-002: strips ```json fences before parsing', () => {
    const out = '```json\n[{"name":"foo","ref":"foo","description":"","stars":null}]\n```';
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates).toEqual([
      { name: 'foo', ref: 'foo', description: '', stars: null },
    ]);
  });

  it('CANDIDATE-PARSE-003: slices JSON out of prose-wrapped output', () => {
    const out =
      'Sure! Here are some skills:\n[{"name":"a","ref":"a","description":"","stars":null}]\nHope this helps.';
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.ref).toBe('a');
  });

  it('CANDIDATE-PARSE-004: returns parsed:false when no JSON array is present', () => {
    const out = "I'm not sure I understand. Could you rephrase?";
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('CANDIDATE-PARSE-005: returns parsed:false on malformed JSON', () => {
    const out = '[{"name":"foo","ref":'; // truncated
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  it('CANDIDATE-PARSE-006: parses empty array as parsed:true with no candidates', () => {
    const out = '[]';
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('CANDIDATE-PARSE-007: drops items missing name or ref', () => {
    const out = JSON.stringify([
      { name: 'good', ref: 'good', description: '', stars: null },
      { name: '', ref: 'noname', description: '', stars: null }, // no name
      { name: 'noref', ref: '', description: '', stars: null }, // no ref
      { ref: 'partial', description: '', stars: null }, // missing name
    ]);
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.ref).toBe('good');
  });

  it('CANDIDATE-PARSE-008: dedupes by ref (first occurrence wins)', () => {
    const out = JSON.stringify([
      { name: 'first', ref: 'dup', description: '', stars: null },
      { name: 'second', ref: 'dup', description: '', stars: null },
    ]);
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.name).toBe('first');
  });

  it('CANDIDATE-PARSE-009: coerces non-integer / negative / NaN stars to null', () => {
    const out = JSON.stringify([
      { name: 'a', ref: 'a', description: '', stars: 'lots' },
      { name: 'b', ref: 'b', description: '', stars: -5 },
      { name: 'c', ref: 'c', description: '', stars: NaN },
      { name: 'd', ref: 'd', description: '', stars: 12.7 },
    ]);
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    // 'lots' (non-number), -5 (clamped to 0), NaN (rejected), 12.7 (floored)
    expect(result.candidates[0]?.stars).toBeNull(); // 'lots'
    expect(result.candidates[1]?.stars).toBe(0); // -5 → max(0, ...)
    expect(result.candidates[2]?.stars).toBeNull(); // NaN
    expect(result.candidates[3]?.stars).toBe(12); // 12.7 → floor
  });

  it('CANDIDATE-PARSE-010: empty string returns parsed:false', () => {
    const result = parseSkillCandidates('');
    expect(result.parsed).toBe(false);
    expect(result.candidates).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Markdown fallback — Claude often ignores the JSON-only instruction
  // and gives a structured prose response. The parser falls through to
  // a markdown extractor that pulls `- \`ref\` — description` lines
  // out of the response. Empirically validated against real Claude
  // output from the porfolio-designer query.
  // -------------------------------------------------------------------------
  it('CANDIDATE-PARSE-011: extracts candidates from em-dash bullet list (Claude prose)', () => {
    const out = `For building or improving a portfolio:
**Core build**
- \`frontend-design\` — distinctive, production-grade UI that avoids generic AI aesthetics.
- \`design-dna\` — extract a design system from references.
**Visual quality pass**
- \`arrange\` — fix layout, spacing, visual hierarchy
- \`polish\` — final alignment/spacing/detail sweep`;
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(4);
    expect(result.candidates.map((c) => c.ref)).toEqual([
      'frontend-design',
      'design-dna',
      'arrange',
      'polish',
    ]);
    expect(result.candidates[0]?.description).toContain('distinctive');
    expect(result.candidates[0]?.stars).toBeNull();
  });

  it('CANDIDATE-PARSE-012: accepts various bullets + separators in markdown lines', () => {
    const out = [
      '- `a` — description-a',
      '* `b` - description-b',
      '• `c`: description-c',
      '- `d` – description-d', // en-dash
    ].join('\n');
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.map((c) => c.ref)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('CANDIDATE-PARSE-013: ignores code spans in prose that are not in bullet form', () => {
    const out = `You should try the \`magic-skill\` for that.
And maybe also \`other-skill\`.`;
    const result = parseSkillCandidates(out);
    // No bullet → not a candidate. The dialog falls back to raw stream.
    expect(result.parsed).toBe(false);
  });

  it('CANDIDATE-PARSE-014: dedupes refs across markdown lines', () => {
    const out = [
      '- `foo` — first description',
      '- `bar` — different',
      '- `foo` — repeat with different text',
    ].join('\n');
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0]?.description).toBe('first description');
  });

  it('CANDIDATE-PARSE-015: JSON takes priority over markdown if both present', () => {
    const out = `Here are some skills:
- \`prose-skill\` — found via markdown
[{"name":"json-skill","ref":"json-skill","description":"from JSON","stars":7}]`;
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.ref).toBe('json-skill');
  });

  // -------------------------------------------------------------------------
  // Markdown-table fallback — Claude's other favorite shape for "find"
  // queries. Real example from a "find" query:
  //   | Skill | Source | Installs | What it does |
  //   |---|---|---|---|
  //   | **find-skills** | `vercel-labs/skills` | 1.5M | Discover ... |
  // The parser composes the install ref as `{source}@{name}` when the
  // source looks like a repo path (matches the `npx skills add` syntax
  // Claude itself recommends).
  // -------------------------------------------------------------------------
  it('CANDIDATE-PARSE-016: extracts candidates from markdown table (Claude "find" response)', () => {
    const out = `Here are the top matches for "find":
| Skill | Source | Installs | What it does |
|---|---|---|---|
| **find-skills** | \`vercel-labs/skills\` | 1.5M | Discover & install agent skills |
| **recipe-find-free-time** | \`googleworkspace/cli\` | 12.8K | Find free time slots in Google Calendar |
| **find-bugs** | \`getsentry/skills\` | 2.4K | Bug hunting via Sentry |
The top result is the very skill that produced this list.`;
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(3);
    expect(result.candidates[0]?.name).toBe('find-skills');
    expect(result.candidates[0]?.ref).toBe('vercel-labs/skills@find-skills');
    expect(result.candidates[0]?.stars).toBe(1_500_000);
    expect(result.candidates[0]?.description).toContain('Discover');
    expect(result.candidates[1]?.ref).toBe('googleworkspace/cli@recipe-find-free-time');
    expect(result.candidates[1]?.stars).toBe(12_800);
    expect(result.candidates[2]?.ref).toBe('getsentry/skills@find-bugs');
    expect(result.candidates[2]?.stars).toBe(2_400);
  });

  it('CANDIDATE-PARSE-017: parses installs counts with K/M/B suffixes', () => {
    const out = `| Skill | Source | Installs | What it does |
|---|---|---|---|
| **a** | \`o/r\` | 42 | plain integer |
| **b** | \`o/r\` | 1.5M | million |
| **c** | \`o/r\` | 12.8K | thousand |
| **d** | \`o/r\` | 2B | billion |
| **e** | \`o/r\` | n/a | unparseable |`;
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    // 5 rows but the ref dedup folds them — each has same `o/r@{name}`
    // unique ref because of unique names.
    expect(result.candidates.length).toBe(5);
    expect(result.candidates[0]?.stars).toBe(42);
    expect(result.candidates[1]?.stars).toBe(1_500_000);
    expect(result.candidates[2]?.stars).toBe(12_800);
    expect(result.candidates[3]?.stars).toBe(2_000_000_000);
    expect(result.candidates[4]?.stars).toBeNull();
  });

  it('CANDIDATE-PARSE-018: table takes priority over bulleted list when both present', () => {
    const out = `| Skill | Source | What it does |
|---|---|---|
| **table-skill** | \`o/r\` | from table |

- \`bullet-skill\` — from bullets`;
    const result = parseSkillCandidates(out);
    expect(result.parsed).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]?.name).toBe('table-skill');
  });
});
