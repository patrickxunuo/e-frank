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
});
