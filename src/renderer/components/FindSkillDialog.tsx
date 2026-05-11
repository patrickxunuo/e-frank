import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { SkillsFindExitEvent, SkillsFindOutputEvent } from '@shared/ipc';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Input } from './Input';
import { IconRefresh, IconSkills } from './icons';
import styles from './FindSkillDialog.module.css';

export interface FindSkillDialogProps {
  open: boolean;
  /** Pre-fills the search input when the dialog opens. */
  initialQuery?: string;
  onClose: () => void;
  /** Called after a successful install so the parent can refresh the list. */
  onInstalled?: () => void;
}

interface OutputLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

interface Candidate {
  /** The skill ref we will pass to `npx skills add`. */
  ref: string;
  /** Display description extracted from the line, may be empty. */
  description: string;
}

/**
 * Lines that look like Claude's enumerated skill recommendations:
 *   - `frontend-design: Create distinctive...`
 *   - `* css-animations — CSS animation adapter patterns...`
 *   - `• figma:figma-use: skill description`
 *
 * Captures the ref (kebab-case, optional `plugin:skill` form) and the
 * remainder of the line as the description. Missed lines fall back to
 * the manual install input below the stream.
 */
const CANDIDATE_RE =
  /^[\s]*[-*•]\s+([a-z][a-z0-9-]+(?::[a-z][a-z0-9-]+)?)\s*[:—-]\s*(.+)$/;

export function FindSkillDialog({
  open,
  initialQuery = '',
  onClose,
  onInstalled,
}: FindSkillDialogProps): JSX.Element {
  const [query, setQuery] = useState<string>(initialQuery);
  const [activeFindId, setActiveFindId] = useState<string | null>(null);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [findError, setFindError] = useState<string | null>(null);
  const [installingRef, setInstallingRef] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [manualRef, setManualRef] = useState<string>('');
  const lineIdRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset state when the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setLines([]);
    setFindError(null);
    setInstallError(null);
    setManualRef('');
    setActiveFindId(null);
    lineIdRef.current = 0;
  }, [open, initialQuery]);

  // Subscribe to streaming output + exit events when a find is in flight.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api || activeFindId === null) {
      return;
    }
    const api = window.api;
    const offOutput = api.skills.onFindOutput((e: SkillsFindOutputEvent) => {
      if (e.findId !== activeFindId) return;
      setLines((prev) => [
        ...prev,
        {
          id: lineIdRef.current++,
          stream: e.stream,
          text: e.line,
        },
      ]);
    });
    const offExit = api.skills.onFindExit((e: SkillsFindExitEvent) => {
      if (e.findId !== activeFindId) return;
      setActiveFindId(null);
      if (e.reason === 'error') {
        setFindError('find-skills failed to run (Claude CLI not installed?).');
      } else if (e.reason === 'completed' && e.exitCode !== null && e.exitCode !== 0) {
        // Surface non-zero exit codes so the user knows /find-skills
        // didn't finish cleanly (e.g. Claude rate-limited or the skill
        // isn't installed). The streamed stderr is already visible
        // in the output area — banner just names the failure.
        setFindError(`find-skills exited with code ${e.exitCode}`);
      }
    });
    return () => {
      offOutput();
      offExit();
    };
  }, [activeFindId]);

  // Auto-scroll the output area when new lines arrive — but ONLY when
  // the user is already pinned to the bottom. If they've scrolled up to
  // read earlier candidates, leave their scroll position alone so we
  // don't yank them back. 8px epsilon absorbs sub-pixel rounding.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= 8) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const candidates = useMemo<Candidate[]>(() => {
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const line of lines) {
      if (line.stream !== 'stdout') continue;
      const m = CANDIDATE_RE.exec(line.text);
      if (m === null) continue;
      const ref = m[1];
      const description = m[2] ?? '';
      if (ref === undefined || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, description });
    }
    return out;
  }, [lines]);

  const handleStartFind = useCallback(
    async (e?: FormEvent<HTMLFormElement>): Promise<void> => {
      e?.preventDefault();
      if (typeof window === 'undefined' || !window.api) return;
      const trimmed = query.trim();
      if (trimmed === '') return;
      setLines([]);
      setFindError(null);
      lineIdRef.current = 0;
      const result = await window.api.skills.findStart({ query: trimmed });
      if (!result.ok) {
        setFindError(result.error.message || result.error.code || 'find-skills failed');
        return;
      }
      setActiveFindId(result.data.findId);
    },
    [query],
  );

  const handleCancel = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api || activeFindId === null) return;
    await window.api.skills.findCancel({ findId: activeFindId });
  }, [activeFindId]);

  const handleInstall = useCallback(
    async (ref: string): Promise<void> => {
      if (typeof window === 'undefined' || !window.api) return;
      const trimmed = ref.trim();
      if (trimmed === '') return;
      setInstallingRef(trimmed);
      setInstallError(null);
      try {
        const result = await window.api.skills.install({ ref: trimmed });
        if (!result.ok) {
          setInstallError(`${result.error.message || result.error.code}`);
          return;
        }
        if (result.data.status === 'failed') {
          const tail = result.data.stderr.trim() || result.data.stdout.trim() || 'install failed';
          setInstallError(tail);
          return;
        }
        // Success — refresh the parent list and clear the manual input.
        setManualRef('');
        onInstalled?.();
      } finally {
        setInstallingRef(null);
      }
    },
    [onInstalled],
  );

  const isFinding = activeFindId !== null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (isFinding) {
          void handleCancel();
        }
        onClose();
      }}
      size="lg"
      title="Find Skill"
      subtitle="Ask Claude what skill best fits your stack or workflow."
      data-testid="find-skill-dialog"
    >
      <div className={styles.body}>
        <form className={styles.searchRow} onSubmit={(e) => void handleStartFind(e)}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "image cropping" or "deploy to fly.io"'
            disabled={isFinding}
            data-testid="find-skill-search"
          />
          {isFinding ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleCancel()}
              data-testid="find-skill-cancel"
            >
              Stop
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              leadingIcon={<IconSkills size={14} />}
              disabled={query.trim() === ''}
              data-testid="find-skill-submit"
            >
              Search
            </Button>
          )}
        </form>

        {findError && (
          <div className={styles.errorBanner} role="alert" data-testid="find-skill-error">
            <strong>Couldn't run find-skills.</strong> {findError}
          </div>
        )}

        <div className={styles.stream} ref={scrollRef} data-testid="find-skill-stream">
          {lines.length === 0 && !isFinding && (
            <div className={styles.streamHint}>
              Search runs Claude's <code>/find-skills</code> with your query and
              streams the response here. Detected recommendations get an inline
              Install button.
            </div>
          )}
          {lines.map((line) => (
            <div
              key={line.id}
              className={styles.streamLine}
              data-stream={line.stream}
            >
              {line.text}
            </div>
          ))}
          {isFinding && lines.length === 0 && (
            <div className={styles.streamSpinner}>
              <IconRefresh size={14} className={styles.spinIcon} />
              <span>Waiting for output…</span>
            </div>
          )}
        </div>

        {candidates.length > 0 && (
          <div className={styles.candidates} data-testid="find-skill-candidates">
            <div className={styles.candidatesHead}>Detected recommendations</div>
            <ul className={styles.candidateList}>
              {candidates.map((c) => (
                <li key={c.ref} className={styles.candidate}>
                  <div className={styles.candidateMeta}>
                    <span className={styles.candidateRef}>{c.ref}</span>
                    {c.description && (
                      <span className={styles.candidateDesc}>{c.description}</span>
                    )}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleInstall(c.ref)}
                    disabled={installingRef !== null}
                    data-testid={`find-skill-install-${c.ref}`}
                  >
                    {installingRef === c.ref ? 'Installing…' : 'Install'}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.manualBlock}>
          <div className={styles.manualHead}>Install by name</div>
          <p className={styles.manualHint}>
            If the recommendation you want isn't detected, paste the skill ref
            here (e.g. <code>ef-feature</code> or <code>owner/repo</code>).
          </p>
          <div className={styles.manualRow}>
            <Input
              value={manualRef}
              onChange={(e) => setManualRef(e.target.value)}
              placeholder="skill-ref"
              data-testid="find-skill-install-input"
            />
            <Button
              variant="primary"
              onClick={() => void handleInstall(manualRef)}
              disabled={manualRef.trim() === '' || installingRef !== null}
              data-testid="find-skill-install-manual"
            >
              {installingRef === manualRef.trim() ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </div>

        {installError && (
          <div className={styles.errorBanner} role="alert" data-testid="find-skill-install-error">
            <strong>Install failed.</strong> {installError}
          </div>
        )}
      </div>
    </Dialog>
  );
}
