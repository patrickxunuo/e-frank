import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type ClaudeCliProbeResponse,
  type ClaudeCliProbeOverrideRequest,
  type ClaudeCliProbeOverrideResponse,
  type ClaudeCliSource,
  type IpcResult,
} from '../../src/shared/ipc';

/**
 * IPC-CLI-001..004 — Claude CLI probe channel contract (#GH-85).
 *
 *  - IPC-CLI-001: the channel string constants exist + have the
 *    expected wire format
 *  - IPC-CLI-002: IpcApi.claudeCli exposes `probe()` and `probeOverride`
 *    with the right shapes
 *  - IPC-CLI-003: drift guard — ClaudeCliProbeResponse has the four
 *    fields the renderer relies on, no more, no less
 *  - IPC-CLI-004: ClaudeCliSource union covers all three states the
 *    probe orchestrator returns
 */

describe('src/shared/ipc.ts — Claude CLI probe channels (#GH-85)', () => {
  describe('IPC-CLI-001: channel strings', () => {
    it('CLAUDE_CLI_PROBE has the expected wire format', () => {
      expect(IPC_CHANNELS.CLAUDE_CLI_PROBE).toBe('claude-cli:probe');
    });

    it('CLAUDE_CLI_PROBE_OVERRIDE has the expected wire format', () => {
      expect(IPC_CHANNELS.CLAUDE_CLI_PROBE_OVERRIDE).toBe('claude-cli:probe-override');
    });
  });

  describe('IPC-CLI-002: IpcApi.claudeCli shape', () => {
    it('probe() returns Promise<IpcResult<ClaudeCliProbeResponse>>', () => {
      type ProbeFn = IpcApi['claudeCli']['probe'];
      expectTypeOf<ProbeFn>().toEqualTypeOf<() => Promise<IpcResult<ClaudeCliProbeResponse>>>();
    });

    it('probeOverride takes a path object and returns the validated payload', () => {
      type OverrideFn = IpcApi['claudeCli']['probeOverride'];
      expectTypeOf<OverrideFn>().toEqualTypeOf<
        (req: ClaudeCliProbeOverrideRequest) => Promise<IpcResult<ClaudeCliProbeOverrideResponse>>
      >();
    });
  });

  describe('IPC-CLI-003: ClaudeCliProbeResponse drift guard', () => {
    it('has exactly { resolvedPath, version, source }', () => {
      type Keys = keyof ClaudeCliProbeResponse;
      expectTypeOf<Keys>().toEqualTypeOf<'resolvedPath' | 'version' | 'source'>();
    });

    it('resolvedPath + version are nullable strings', () => {
      expectTypeOf<ClaudeCliProbeResponse['resolvedPath']>().toEqualTypeOf<string | null>();
      expectTypeOf<ClaudeCliProbeResponse['version']>().toEqualTypeOf<string | null>();
    });
  });

  describe('IPC-CLI-004: source union', () => {
    it("ClaudeCliSource = 'override' | 'path' | 'not-found'", () => {
      expectTypeOf<ClaudeCliSource>().toEqualTypeOf<'override' | 'path' | 'not-found'>();
    });
  });
});
