import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeHttpClient,
  type HttpResult,
} from '../../src/main/modules/http-client';

/**
 * HttpClient acceptance tests (HTTP-001 .. HTTP-005).
 *
 * Only `FakeHttpClient` is exercised here — `FetchHttpClient` would hit a real
 * network and is therefore covered (if at all) by integration tests outside
 * the unit suite. Per acceptance rule 6: no real Jira / network calls in the
 * unit test suite.
 */

const HOST = 'https://example.atlassian.net';

function okResponse(body: string, status = 200): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body,
    },
  };
}

describe('FakeHttpClient', () => {
  let client: FakeHttpClient;

  beforeEach(() => {
    client = new FakeHttpClient();
  });

  // -------------------------------------------------------------------------
  // HTTP-001 — exact match
  // -------------------------------------------------------------------------
  describe('HTTP-001 exact match', () => {
    it('HTTP-001: registered expect() returns the canned response', async () => {
      const url = `${HOST}/rest/api/3/myself`;
      client.expect('GET', url, okResponse('{"accountId":"abc"}'));

      const res = await client.request({ method: 'GET', url });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.response.status).toBe(200);
      expect(res.response.body).toBe('{"accountId":"abc"}');
    });
  });

  // -------------------------------------------------------------------------
  // HTTP-002 — unmatched request → NETWORK error
  // -------------------------------------------------------------------------
  describe('HTTP-002 unmatched request', () => {
    it('HTTP-002: unmatched request returns NETWORK error mentioning method+url', async () => {
      const url = `${HOST}/rest/api/3/something`;
      const res = await client.request({ method: 'GET', url });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('NETWORK');
      // Message should reference the unmatched method and URL so the test
      // failure is debuggable.
      expect(res.error.message).toContain('GET');
      expect(res.error.message).toContain(url);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP-003 — expectPrefix matches multiple URLs
  // -------------------------------------------------------------------------
  describe('HTTP-003 expectPrefix', () => {
    it('HTTP-003: expectPrefix matches every URL that starts with prefix', async () => {
      const prefix = `${HOST}/rest/api/3/search`;
      client.expectPrefix(
        'GET',
        prefix,
        okResponse('{"total":0,"issues":[]}'),
      );

      const r1 = await client.request({
        method: 'GET',
        url: `${prefix}?jql=project%20%3D%20%22A%22&maxResults=50`,
      });
      const r2 = await client.request({
        method: 'GET',
        url: `${prefix}?jql=project%20%3D%20%22B%22&maxResults=50`,
      });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.response.body).toBe('{"total":0,"issues":[]}');
      expect(r2.response.body).toBe('{"total":0,"issues":[]}');
    });

    it('HTTP-003: expectPrefix does NOT match unrelated URLs', async () => {
      client.expectPrefix(
        'GET',
        `${HOST}/rest/api/3/search`,
        okResponse('{"total":0}'),
      );

      const res = await client.request({
        method: 'GET',
        url: `${HOST}/rest/api/3/myself`,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('NETWORK');
    });
  });

  // -------------------------------------------------------------------------
  // HTTP-004 — calls log
  // -------------------------------------------------------------------------
  describe('HTTP-004 calls log', () => {
    it('HTTP-004: every invocation is recorded in invocation order', async () => {
      const url1 = `${HOST}/rest/api/3/myself`;
      const url2 = `${HOST}/rest/api/3/search?jql=foo`;

      client.expect('GET', url1, okResponse('{}'));
      client.expect('GET', url2, okResponse('{}'));

      await client.request({ method: 'GET', url: url1 });
      await client.request({ method: 'GET', url: url2 });
      // An unmatched call still records, even though it returns an error.
      await client.request({ method: 'POST', url: `${HOST}/rest/api/3/issue` });

      expect(client.calls).toHaveLength(3);
      expect(client.calls[0]?.method).toBe('GET');
      expect(client.calls[0]?.url).toBe(url1);
      expect(client.calls[1]?.method).toBe('GET');
      expect(client.calls[1]?.url).toBe(url2);
      expect(client.calls[2]?.method).toBe('POST');
      expect(client.calls[2]?.url).toBe(`${HOST}/rest/api/3/issue`);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP-005 — reset()
  // -------------------------------------------------------------------------
  describe('HTTP-005 reset()', () => {
    it('HTTP-005: reset() clears expectations and call log', async () => {
      const url = `${HOST}/rest/api/3/myself`;
      client.expect('GET', url, okResponse('{}'));
      await client.request({ method: 'GET', url });
      expect(client.calls).toHaveLength(1);

      client.reset();
      expect(client.calls).toHaveLength(0);

      // After reset, the previously-registered expectation is gone.
      const res = await client.request({ method: 'GET', url });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('NETWORK');
    });
  });
});
