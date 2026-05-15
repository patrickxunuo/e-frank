// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FindSkillDialog } from '../../src/renderer/components/FindSkillDialog';
import type {
  ApiSkill,
  IpcApi,
  IpcResult,
  SkillsInstallResponse,
  SkillsSearchResponse,
} from '../../src/shared/ipc';

/**
 * FindSkillDialog tests for the GH-93 rewrite. The dialog now:
 *   - Calls `window.api.skills.search({query, limit})` (no streaming).
 *   - Renders one row per result with name + source + installs.
 *   - Shows an "Installed" badge + disabled Install button when the
 *     row's skillId is in the `installedIds` prop.
 *   - Pages via an IntersectionObserver sentinel — bumping `limit` by
 *     PAGE_SIZE (20) per scroll until count or 200-cap is reached.
 *   - Debounces input-driven searches by 500ms.
 *   - Surfaces HTTP error codes from the search IPC in an error banner.
 *
 * IntersectionObserver isn't implemented by jsdom — tests that need to
 * trigger page-load capture the observer's callback via a vi.stubGlobal.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface IOEntry {
  isIntersecting: boolean;
  target: Element;
}

interface CapturedObserver {
  callback: (entries: IOEntry[]) => void;
  observed: Element[];
}

let activeObservers: CapturedObserver[] = [];

function installIntersectionObserverStub(): void {
  class MockIO {
    private cb: (entries: IOEntry[]) => void;
    constructor(cb: (entries: IOEntry[]) => void) {
      this.cb = cb;
      activeObservers.push({ callback: cb, observed: [] });
    }
    observe(el: Element): void {
      const o = activeObservers.find((a) => a.callback === this.cb);
      if (o) o.observed.push(el);
    }
    unobserve(): void {}
    disconnect(): void {
      activeObservers = activeObservers.filter((o) => o.callback !== this.cb);
    }
    takeRecords(): IOEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', MockIO);
}

function triggerSentinelIntersect(): void {
  for (const o of activeObservers) {
    for (const el of o.observed) {
      o.callback([{ isIntersecting: true, target: el }]);
    }
  }
}

interface ApiStub {
  api: IpcApi;
  search: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
}

function unusedErr(): IpcResult<never> {
  return { ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } };
}

function installApi(opts?: {
  searchResults?: ApiSkill[];
  searchTotal?: number;
  searchSequence?: Array<IpcResult<SkillsSearchResponse>>;
  searchError?: { code: string; message: string };
  installResult?: IpcResult<SkillsInstallResponse>;
}): ApiStub {
  let searchCallIdx = 0;
  const search = vi.fn(async () => {
    if (opts?.searchSequence) {
      const r = opts.searchSequence[searchCallIdx];
      searchCallIdx++;
      if (r !== undefined) return r;
      return opts.searchSequence[
        opts.searchSequence.length - 1
      ] as IpcResult<SkillsSearchResponse>;
    }
    if (opts?.searchError) {
      return { ok: false, error: opts.searchError } as IpcResult<SkillsSearchResponse>;
    }
    const skills = opts?.searchResults ?? [];
    const count = opts?.searchTotal ?? skills.length;
    return { ok: true, data: { skills, count } } as IpcResult<SkillsSearchResponse>;
  });
  const install = vi
    .fn()
    .mockResolvedValue(
      opts?.installResult ?? {
        ok: true,
        data: { status: 'installed', stdout: 'ok', stderr: '', exitCode: 0 },
      },
    );
  const openExternal = vi.fn().mockResolvedValue({ ok: true, data: null });

  const api: IpcApi = {
    ping: vi.fn().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    app: { info: vi.fn().mockResolvedValue(unusedErr()) },
    claudeCli: {
      probe: vi.fn().mockResolvedValue(unusedErr()),
      probeOverride: vi.fn().mockResolvedValue(unusedErr()),
    },
    claude: {
      run: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      write: vi.fn().mockResolvedValue(unusedErr()),
      status: vi.fn().mockResolvedValue({ ok: true, data: { active: null } }),
      onOutput: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    } as unknown as IpcApi['claude'],
    projects: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    } as unknown as IpcApi['projects'],
    secrets: {} as unknown as IpcApi['secrets'],
    jira: {} as unknown as IpcApi['jira'],
    runs: {} as unknown as IpcApi['runs'],
    connections: {} as unknown as IpcApi['connections'],
    dialog: {} as unknown as IpcApi['dialog'],
    tickets: {} as unknown as IpcApi['tickets'],
    pulls: {} as unknown as IpcApi['pulls'],
    chrome: {} as unknown as IpcApi['chrome'],
    skills: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { skills: [] } }),
      install,
      remove: vi.fn().mockResolvedValue(unusedErr()),
      search,
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
      openExternal,
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue(unusedErr()),
      set: vi.fn().mockResolvedValue(unusedErr()),
    },
  } as IpcApi;

  (window as { api?: IpcApi }).api = api;

  return { api, search, install, openExternal };
}

function row(overrides: Partial<ApiSkill> = {}): ApiSkill {
  return {
    id: `vercel-labs/agent-skills/${overrides.skillId ?? 'demo'}`,
    skillId: overrides.skillId ?? 'demo',
    name: overrides.name ?? overrides.skillId ?? 'demo',
    installs: overrides.installs ?? 1234,
    source: overrides.source ?? 'vercel-labs/agent-skills',
    ...overrides,
  };
}

beforeEach(() => {
  installIntersectionObserverStub();
});

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  activeObservers = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FindSkillDialog (GH-93)', () => {
  // -- DIALOG-001 — basic render ----------------------------------------
  it('DIALOG-001: open dialog renders search input + submit button + hint', () => {
    installApi();
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    expect(screen.getByTestId('find-skill-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('find-skill-search')).toBeInTheDocument();
    expect(screen.getByTestId('find-skill-submit')).toBeInTheDocument();
    expect(screen.getByTestId('find-skill-hint')).toBeInTheDocument();
  });

  it('DIALOG-002: closed dialog does not render', () => {
    installApi();
    render(
      <FindSkillDialog open={false} installedSkills={[]} onClose={() => {}} />,
    );
    expect(screen.queryByTestId('find-skill-dialog')).not.toBeInTheDocument();
  });

  it('DIALOG-003: initialQuery prop pre-fills the search input', () => {
    installApi();
    render(
      <FindSkillDialog
        open={true}
        initialQuery="ef-feature"
        installedSkills={[]}
        onClose={() => {}}
      />,
    );
    const input = screen.getByTestId('find-skill-search') as HTMLInputElement;
    expect(input.value).toBe('ef-feature');
  });

  // -- DIALOG-SUBMIT-001 — submit dispatches search IPC + renders rows --
  it('DIALOG-SUBMIT-001: clicking Search submits a search and renders result rows', async () => {
    const r1 = row({
      skillId: 'frontend-design',
      name: 'frontend-design',
      installs: 320851,
    });
    const stub = installApi({ searchResults: [r1] });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ui' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.search).toHaveBeenCalledWith({ query: 'ui', limit: 20 });
    });
    const rowEl = await screen.findByTestId('find-skill-row-frontend-design');
    expect(rowEl).toHaveTextContent('frontend-design');
    expect(rowEl).toHaveTextContent('vercel-labs/agent-skills');
    expect(rowEl).toHaveTextContent('320.9K installs');
  });

  it('DIALOG-SUBMIT-002: submit button is disabled when query is empty', async () => {
    const stub = installApi();
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    const submit = screen.getByTestId('find-skill-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.search).not.toHaveBeenCalled();
  });

  // -- DIALOG-INSTALLED-001 — installed dedupe --------------------------
  it('DIALOG-INSTALLED-001: a legacy install (sourceRepo: null) matches by name only — Installed badge + disabled button', async () => {
    // sourceRepo: null is the pre-tracker fallback. Anything with the
    // same skillId locally counts as installed, regardless of the API's
    // source field. New installs (sourceRepo set) get exact-match
    // dedupe — exercised by DIALOG-INSTALLED-SOURCE-001..003 below.
    const r1 = row({ skillId: 'ef-feature', name: 'ef-feature' });
    const r2 = row({ skillId: 'frontend-design', name: 'frontend-design' });
    installApi({ searchResults: [r1, r2] });
    render(
      <FindSkillDialog
        open={true}
        installedSkills={[{ id: 'ef-feature', sourceRepo: null }]}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ef' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));

    const installedRow = await screen.findByTestId('find-skill-row-ef-feature');
    expect(installedRow).toHaveTextContent('Installed');
    const installedBtn = screen.getByTestId(
      'find-skill-install-ef-feature',
    ) as HTMLButtonElement;
    expect(installedBtn.disabled).toBe(true);

    const freshRow = await screen.findByTestId(
      'find-skill-row-frontend-design',
    );
    expect(freshRow).not.toHaveTextContent(/Installed$/);
    const freshBtn = screen.getByTestId(
      'find-skill-install-frontend-design',
    ) as HTMLButtonElement;
    expect(freshBtn.disabled).toBe(false);
  });

  // -- DIALOG-INSTALLED-SOURCE-001..003 — source-aware dedupe ---------------
  it('DIALOG-INSTALLED-SOURCE-001: same skillId AND same sourceRepo → Installed', async () => {
    const r1 = row({
      skillId: 'frontend-design',
      name: 'frontend-design',
      source: 'vercel-labs/agent-skills',
    });
    installApi({ searchResults: [r1] });
    render(
      <FindSkillDialog
        open={true}
        installedSkills={[{ id: 'frontend-design', sourceRepo: 'vercel-labs/agent-skills' }]}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    const row1 = await screen.findByTestId('find-skill-row-frontend-design');
    expect(row1).toHaveTextContent('Installed');
    const btn = screen.getByTestId('find-skill-install-frontend-design') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('DIALOG-INSTALLED-SOURCE-002: same skillId but DIFFERENT sourceRepo → NOT installed', async () => {
    // The API returns a frontend-design from one source; locally we have
    // a frontend-design from a different source. The local clobber-risk
    // is real but that's a separate UX problem — for dedupe purposes,
    // different source = different skill, so Install stays enabled.
    const r1 = row({
      skillId: 'frontend-design',
      name: 'frontend-design',
      source: 'unknown-author/some-other-repo',
    });
    installApi({ searchResults: [r1] });
    render(
      <FindSkillDialog
        open={true}
        installedSkills={[{ id: 'frontend-design', sourceRepo: 'vercel-labs/agent-skills' }]}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    const row1 = await screen.findByTestId('find-skill-row-frontend-design');
    expect(row1).not.toHaveTextContent(/Installed$/);
    const btn = screen.getByTestId('find-skill-install-frontend-design') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('DIALOG-INSTALLED-SOURCE-003: skillId NOT in installedSkills → NOT installed (no false positive)', async () => {
    const r1 = row({
      skillId: 'unrelated-skill',
      name: 'unrelated-skill',
      source: 'vercel-labs/agent-skills',
    });
    installApi({ searchResults: [r1] });
    render(
      <FindSkillDialog
        open={true}
        installedSkills={[{ id: 'frontend-design', sourceRepo: 'vercel-labs/agent-skills' }]}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'unrelated' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    const row1 = await screen.findByTestId('find-skill-row-unrelated-skill');
    expect(row1).not.toHaveTextContent(/Installed$/);
    const btn = screen.getByTestId('find-skill-install-unrelated-skill') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  // -- DIALOG-INSTALL-001 — install dispatches IPC + onInstalled callback
  it('DIALOG-INSTALL-001: clicking Install calls skills.install with the source repo (owner/repo), not the skillId', async () => {
    // The skills CLI clones the source repo to install — passing just
    // `skillId` makes it try to clone a non-existent top-level repo. The
    // source field on the API response is the owner/repo path.
    const r1 = row({
      skillId: 'frontend-design',
      name: 'frontend-design',
      source: 'vercel-labs/agent-skills',
    });
    const stub = installApi({ searchResults: [r1] });
    const onInstalled = vi.fn();
    render(
      <FindSkillDialog
        open={true}
        installedSkills={[]}
        onClose={() => {}}
        onInstalled={onInstalled}
      />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-install-frontend-design');
    fireEvent.click(screen.getByTestId('find-skill-install-frontend-design'));
    await waitFor(() => {
      // The install dispatches `ref` (owner/repo for `skills add`) plus
      // `skillId` (folder name) so main can write the source-tracker
      // entry on success — that's what powers source-aware dedupe.
      expect(stub.install).toHaveBeenCalledWith({
        ref: 'vercel-labs/agent-skills',
        skillId: 'frontend-design',
      });
    });
    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalled();
    });
  });

  it('DIALOG-INSTALL-002: install failure surfaces an inline error banner', async () => {
    const r1 = row({ skillId: 'frontend-design', name: 'frontend-design' });
    installApi({
      searchResults: [r1],
      installResult: {
        ok: false,
        error: { code: 'INVALID_REF', message: 'bad ref' },
      },
    });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-install-frontend-design');
    fireEvent.click(screen.getByTestId('find-skill-install-frontend-design'));
    const banner = await screen.findByTestId('find-skill-install-error');
    expect(banner).toHaveTextContent(/bad ref/);
  });

  // -- DIALOG-ERROR-001 — search failure banner -------------------------
  it('DIALOG-ERROR-001: search HTTP error renders the error banner', async () => {
    installApi({ searchError: { code: 'RATE_LIMITED', message: 'too many requests' } });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ui' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    const banner = await screen.findByTestId('find-skill-error');
    expect(banner).toHaveTextContent(/too many requests/);
  });

  // -- DIALOG-PAGING-001 — sentinel intersect bumps the limit -----------
  it('DIALOG-PAGING-001: sentinel intersect triggers a follow-up search with limit += PAGE_SIZE', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) =>
      row({ skillId: `skill-${i}`, name: `skill-${i}` }),
    );
    const secondPage = [
      ...firstPage,
      ...Array.from({ length: 20 }, (_, i) =>
        row({ skillId: `skill-${20 + i}`, name: `skill-${20 + i}` }),
      ),
    ];
    const stub = installApi({
      searchSequence: [
        { ok: true, data: { skills: firstPage, count: 100 } },
        { ok: true, data: { skills: secondPage, count: 100 } },
      ],
    });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ui' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.search).toHaveBeenCalledWith({ query: 'ui', limit: 20 });
    });
    await screen.findByTestId('find-skill-row-skill-0');

    triggerSentinelIntersect();
    await waitFor(() => {
      expect(stub.search).toHaveBeenCalledWith({ query: 'ui', limit: 40 });
    });
    await screen.findByTestId('find-skill-row-skill-20');
  });

  it('DIALOG-PAGING-002: when results.length >= count, sentinel intersect does not refetch and exhaustion footer appears', async () => {
    const onePage = [row({ skillId: 'only-one', name: 'only-one' })];
    const stub = installApi({ searchResults: onePage, searchTotal: 1 });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ui' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-row-only-one');
    expect(await screen.findByTestId('find-skill-exhausted')).toBeInTheDocument();
    triggerSentinelIntersect();
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.search).toHaveBeenCalledTimes(1);
  });

  it('DIALOG-PAGING-003: 200-result cap stops further paging with cap-reached footer', async () => {
    const buildPage = (n: number): ApiSkill[] =>
      Array.from({ length: n }, (_, i) =>
        row({ skillId: `s-${i}`, name: `s-${i}` }),
      );
    const stub = installApi({
      searchSequence: [
        { ok: true, data: { skills: buildPage(20), count: 1000 } },
        { ok: true, data: { skills: buildPage(40), count: 1000 } },
        { ok: true, data: { skills: buildPage(60), count: 1000 } },
        { ok: true, data: { skills: buildPage(80), count: 1000 } },
        { ok: true, data: { skills: buildPage(100), count: 1000 } },
        { ok: true, data: { skills: buildPage(120), count: 1000 } },
        { ok: true, data: { skills: buildPage(140), count: 1000 } },
        { ok: true, data: { skills: buildPage(160), count: 1000 } },
        { ok: true, data: { skills: buildPage(180), count: 1000 } },
        { ok: true, data: { skills: buildPage(200), count: 1000 } },
      ],
    });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'ui' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-row-s-0');
    for (let i = 0; i < 12; i++) {
      triggerSentinelIntersect();
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => {
      expect(screen.getByTestId('find-skill-cap-reached')).toBeInTheDocument();
    });
    const limits = stub.search.mock.calls.map(
      (c) => (c[0] as { limit: number }).limit,
    );
    expect(Math.max(...limits)).toBe(200);
  });

  // -- DIALOG-EMPTY-001 — empty results ---------------------------------
  it('DIALOG-EMPTY-001: empty result set shows the empty-result hint', async () => {
    installApi({ searchResults: [], searchTotal: 0 });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'nonexistent' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-empty-result');
  });

  // -- DIALOG-RESET-001 — reopening clears prior state ------------------
  it('DIALOG-RESET-001: reopening the dialog clears prior results + query (no result caching)', async () => {
    const r1 = row({ skillId: 'cached-one' });
    const stub = installApi({ searchResults: [r1] });
    const { rerender } = render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'foo' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-row-cached-one');

    rerender(
      <FindSkillDialog open={false} installedSkills={[]} onClose={() => {}} />,
    );
    rerender(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    expect(
      screen.queryByTestId('find-skill-row-cached-one'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('find-skill-hint')).toBeInTheDocument();
    expect(stub.search).toHaveBeenCalledTimes(1);
  });

  // -- DIALOG-W1-001 — install-error clears on new search (review W1) ----
  it('DIALOG-W1-001: install-error banner is cleared when a new search kicks off', async () => {
    const r1 = row({ skillId: 'frontend-design', name: 'frontend-design' });
    installApi({
      searchResults: [r1],
      installResult: {
        ok: false,
        error: { code: 'INVALID_REF', message: 'bad ref' },
      },
    });
    render(
      <FindSkillDialog open={true} installedSkills={[]} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-install-frontend-design');
    fireEvent.click(screen.getByTestId('find-skill-install-frontend-design'));
    await screen.findByTestId('find-skill-install-error');

    // Now kick off a new search — the install-error banner should
    // disappear so the user isn't haunted by a previous attempt's
    // failure during their next query.
    fireEvent.change(screen.getByTestId('find-skill-search'), {
      target: { value: 'design2' },
    });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('find-skill-install-error'),
      ).not.toBeInTheDocument();
    });
  });
});
