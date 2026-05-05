import { describe, it, expect } from 'vitest';
import { StubJiraUpdater } from '../../src/main/modules/jira-updater';

/**
 * JIRA-UPD-STUB-001 — StubJiraUpdater always returns ok. Real Jira-update
 * implementation lands in #13.
 */

describe('StubJiraUpdater', () => {
  describe('JIRA-UPD-STUB-001 update', () => {
    it('JIRA-UPD-STUB-001: update returns ok with the same ticketKey', async () => {
      const updater = new StubJiraUpdater();
      const result = await updater.update({
        ticketKey: 'ABC-1',
        prUrl: 'https://example.test/pr/1',
        transitionTo: 'In Review',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.ticketKey).toBe('ABC-1');
    });

    it('JIRA-UPD-STUB-001: works without a transitionTo', async () => {
      const updater = new StubJiraUpdater();
      const result = await updater.update({
        ticketKey: 'XYZ-9',
        prUrl: 'https://example.test/pr/9',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.ticketKey).toBe('XYZ-9');
    });
  });
});
