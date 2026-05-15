import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type ApiSkill,
  type SkillsSearchRequest,
  type SkillsSearchResponse,
} from '../../src/shared/ipc';

/**
 * IPC contract tests for the skills.sh direct-search refactor (#GH-93).
 *
 * Covers:
 *  - IPC-SKILLS-S-001: SKILLS_SEARCH channel string
 *  - IPC-SKILLS-S-002: IpcApi.skills.search signature
 *  - IPC-SKILLS-S-003: payload type shapes (request + response + ApiSkill)
 *  - IPC-SKILLS-S-004: drift guard — the deleted SKILLS_FIND_* channels
 *    are gone from IPC_CHANNELS so a regression can't add them back
 *  - IPC-SKILLS-S-005: regression — list/install/remove still present
 */

describe('src/shared/ipc.ts — skills.search (GH-93)', () => {
  describe('IPC-SKILLS-S-001 channel string', () => {
    it('SKILLS_SEARCH === "skills:search"', () => {
      expect(IPC_CHANNELS.SKILLS_SEARCH).toBe('skills:search');
    });

    it('skills search channel value is typed as its string literal', () => {
      expectTypeOf(IPC_CHANNELS.SKILLS_SEARCH).toEqualTypeOf<'skills:search'>();
    });

    it('SKILLS_SEARCH key is present on IPC_CHANNELS', () => {
      expect(Object.keys(IPC_CHANNELS)).toContain('SKILLS_SEARCH');
    });
  });

  describe('IPC-SKILLS-S-002 IpcApi.skills.search shape', () => {
    it('IpcApi.skills has a `search` method', () => {
      expectTypeOf<IpcApi['skills']>().toHaveProperty('search');
    });

    it('skills.search returns Promise<IpcResult<SkillsSearchResponse>>', () => {
      expectTypeOf<IpcApi['skills']['search']>().toEqualTypeOf<
        (req: SkillsSearchRequest) => Promise<IpcResult<SkillsSearchResponse>>
      >();
    });
  });

  describe('IPC-SKILLS-S-003 payload shapes', () => {
    it('SkillsSearchRequest has query: string + limit: number', () => {
      expectTypeOf<SkillsSearchRequest>().toEqualTypeOf<{
        query: string;
        limit: number;
      }>();
    });

    it('SkillsSearchResponse has skills: ApiSkill[] + count: number', () => {
      expectTypeOf<SkillsSearchResponse>().toEqualTypeOf<{
        skills: ApiSkill[];
        count: number;
      }>();
    });

    it('ApiSkill has the 5 documented fields', () => {
      expectTypeOf<ApiSkill>().toEqualTypeOf<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>();
    });
  });

  describe('IPC-SKILLS-S-004 drift guard: deleted SKILLS_FIND_* channels are gone', () => {
    it('no SKILLS_FIND_START key on IPC_CHANNELS', () => {
      expect(Object.keys(IPC_CHANNELS)).not.toContain('SKILLS_FIND_START');
    });
    it('no SKILLS_FIND_CANCEL key on IPC_CHANNELS', () => {
      expect(Object.keys(IPC_CHANNELS)).not.toContain('SKILLS_FIND_CANCEL');
    });
    it('no SKILLS_FIND_OUTPUT key on IPC_CHANNELS', () => {
      expect(Object.keys(IPC_CHANNELS)).not.toContain('SKILLS_FIND_OUTPUT');
    });
    it('no SKILLS_FIND_EXIT key on IPC_CHANNELS', () => {
      expect(Object.keys(IPC_CHANNELS)).not.toContain('SKILLS_FIND_EXIT');
    });
    it('IpcApi.skills no longer exposes findStart / findCancel / onFindOutput / onFindExit', () => {
      // TypeScript-level drift guard. If anyone re-adds them, the next
      // `expectTypeOf<IpcApi['skills']>().toHaveProperty('search')` style
      // test won't catch the regression — but a `keyof` extract here will.
      type SkillsKeys = keyof IpcApi['skills'];
      expectTypeOf<SkillsKeys>().toEqualTypeOf<
        'list' | 'install' | 'remove' | 'search'
      >();
    });
  });

  describe('IPC-SKILLS-S-005 regression: prior skill channels intact', () => {
    it('SKILLS_LIST / SKILLS_INSTALL / SKILLS_REMOVE channel strings unchanged', () => {
      expect(IPC_CHANNELS.SKILLS_LIST).toBe('skills:list');
      expect(IPC_CHANNELS.SKILLS_INSTALL).toBe('skills:install');
      expect(IPC_CHANNELS.SKILLS_REMOVE).toBe('skills:remove');
    });
  });
});
