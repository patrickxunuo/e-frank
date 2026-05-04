/**
 * Shared IPC contract between the Electron main process and the React renderer.
 *
 * Channel naming convention: `<module>:<action>` (kebab-case after the colon).
 * All channel names and payload shapes MUST be declared here — no string
 * literals scattered through main/preload/renderer code.
 */

export const IPC_CHANNELS = {
  PING: 'app:ping',
} as const;

export type PingRequest = { message: string };
export type PingResponse = { reply: string; receivedAt: number };

export interface IpcApi {
  ping: (req: PingRequest) => Promise<PingResponse>;
}
