/**
 * `useClaudeCli()` — Settings → Claude CLI section hook (#GH-85).
 *
 * Drives the four UI states the section needs:
 *   - `loading` — initial probe in flight
 *   - `found` — Claude CLI resolved (either from appConfig.claudeCliPath
 *     or PATH lookup) and `--version` returned a string
 *   - `not-found` — no override, PATH lookup found nothing; show install
 *     instructions
 *   - `error` — probe IPC failed entirely (rare — bridge missing, store
 *     not initialized, etc.)
 *
 * Exposes three actions: `refresh()` (re-runs the probe), `testOverride()`
 * (validation gate via `claude-cli:probe-override` — does NOT persist),
 * and `saveOverride()` / `clearOverride()` (writes via `appConfig.set`
 * and then re-probes so the resolved-path row updates). The renderer
 * uses `testOverride` to gate the Save button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClaudeCliProbeResponse,
  ClaudeCliProbeOverrideResponse,
  ClaudeCliSource,
  IpcResult,
} from '@shared/ipc';

export type ClaudeCliState = 'loading' | 'found' | 'not-found' | 'error';

export interface UseClaudeCliResult {
  state: ClaudeCliState;
  resolvedPath: string | null;
  version: string | null;
  source: ClaudeCliSource;
  error: string | null;
  refresh: () => Promise<void>;
  testOverride: (
    path: string,
  ) => Promise<IpcResult<ClaudeCliProbeOverrideResponse>>;
  saveOverride: (path: string) => Promise<IpcResult<null>>;
  clearOverride: () => Promise<IpcResult<null>>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

function classify(probe: ClaudeCliProbeResponse): ClaudeCliState {
  if (probe.source === 'not-found') return 'not-found';
  if (probe.resolvedPath !== null && probe.version !== null) return 'found';
  // Override is configured but the binary is broken (file missing, or
  // --version returned no version). Surface as not-found so the UI
  // shows the same install-instructions affordance — the user fixes
  // it by clearing the override or pointing it at a real binary.
  return 'not-found';
}

export function useClaudeCli(): UseClaudeCliResult {
  const bridgeMissing = typeof window === 'undefined' || !window.api;
  const [state, setState] = useState<ClaudeCliState>(bridgeMissing ? 'error' : 'loading');
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [source, setSource] = useState<ClaudeCliSource>(
    bridgeMissing ? 'not-found' : 'not-found',
  );
  const [error, setError] = useState<string | null>(
    bridgeMissing ? BRIDGE_UNAVAILABLE : null,
  );

  // Unmounted-after-async setState protection. The ref pattern mirrors
  // what `useAppInfo` does via a per-effect `cancelled` boolean; here
  // the probe is callable from outside useEffect (refresh, save, clear)
  // so a component-level ref is the right shape.
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runProbe = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (!mountedRef.current) return;
      setState('error');
      setError(BRIDGE_UNAVAILABLE);
      return;
    }
    if (mountedRef.current) setState('loading');
    try {
      const result = await window.api.claudeCli.probe();
      if (!mountedRef.current) return;
      if (result.ok) {
        setResolvedPath(result.data.resolvedPath);
        setVersion(result.data.version);
        setSource(result.data.source);
        setError(null);
        setState(classify(result.data));
      } else {
        setState('error');
        setError(result.error.message || result.error.code);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (bridgeMissing) return;
    void runProbe();
  }, [bridgeMissing, runProbe]);

  const testOverride = useCallback(
    async (path: string): Promise<IpcResult<ClaudeCliProbeOverrideResponse>> => {
      if (typeof window === 'undefined' || !window.api) {
        return { ok: false, error: { code: 'BRIDGE_MISSING', message: BRIDGE_UNAVAILABLE } };
      }
      return window.api.claudeCli.probeOverride({ path });
    },
    [],
  );

  const saveOverride = useCallback(
    async (path: string): Promise<IpcResult<null>> => {
      if (typeof window === 'undefined' || !window.api) {
        return { ok: false, error: { code: 'BRIDGE_MISSING', message: BRIDGE_UNAVAILABLE } };
      }
      const r = await window.api.appConfig.set({ partial: { claudeCliPath: path } });
      if (!r.ok) return { ok: false, error: r.error };
      // Re-probe so the "Resolved path" row reflects the new override
      // without the user having to click Refresh.
      await runProbe();
      return { ok: true, data: null };
    },
    [runProbe],
  );

  const clearOverride = useCallback(async (): Promise<IpcResult<null>> => {
    if (typeof window === 'undefined' || !window.api) {
      return { ok: false, error: { code: 'BRIDGE_MISSING', message: BRIDGE_UNAVAILABLE } };
    }
    const r = await window.api.appConfig.set({ partial: { claudeCliPath: null } });
    if (!r.ok) return { ok: false, error: r.error };
    await runProbe();
    return { ok: true, data: null };
  }, [runProbe]);

  return {
    state,
    resolvedPath,
    version,
    source,
    error,
    refresh: runProbe,
    testOverride,
    saveOverride,
    clearOverride,
  };
}
