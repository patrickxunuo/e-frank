/**
 * ANSI escape-sequence stripping for the Execution View log.
 *
 * MVP: strip CSI sequences (`\x1b[...<final-byte>`). Full color rendering
 * is a follow-up; for #8 we present plain monospace text. The regex covers
 * the common SGR/cursor-position forms emitted by claude/the OS shell.
 */

// CSI = ESC '[' followed by zero or more parameter bytes (digits / ';') and
// a single final byte in the 0x40–0x7E range (a letter, basically). This
// catches color codes (`\x1b[31m`), cursor moves, erase-in-line, etc.
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Remove ANSI CSI escape sequences from `s`. Idempotent. */
export function stripAnsi(s: string): string {
  return s.replace(CSI_PATTERN, '');
}
