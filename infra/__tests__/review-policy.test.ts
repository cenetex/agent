import {
  hasBlockingAutoMergeLabel,
  hasCurrentBotApproval,
  hasCurrentBotAttestation,
} from '../lib/review-policy';

const BOT_LOGINS = ['cenetex[bot]', 'github-agent[bot]'];
const HEAD_SHA = 'a'.repeat(40);

describe('review policy', () => {
  it('blocks auto-merge for pause and human-required labels', () => {
    expect(hasBlockingAutoMergeLabel(['review:approved'])).toBe(false);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'pause-agent'])).toBe(true);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'review:human-required'])).toBe(true);
  });

  it('accepts a current approving review from a configured bot login', () => {
    expect(hasCurrentBotApproval([
      {
        state: 'APPROVED',
        commit_id: HEAD_SHA,
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(true);
  });

  it('rejects approval from a human or unknown login', () => {
    expect(hasCurrentBotApproval([
      {
        state: 'APPROVED',
        commit_id: HEAD_SHA,
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(false);
  });

  it('rejects an approval that does not bind the current head SHA', () => {
    expect(hasCurrentBotApproval([
      {
        state: 'APPROVED',
        commit_id: 'def456',
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(false);
  });

  it('rejects when the latest bot review requests changes', () => {
    expect(hasCurrentBotApproval([
      {
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD_SHA,
        submitted_at: '2026-05-14T01:00:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(false);
  });

  it('accepts the latest exact-head attestation from a configured bot', () => {
    expect(hasCurrentBotAttestation([
      {
        id: 10,
        body: `<!-- cenetex-review-attestation:v1 head=${HEAD_SHA} decision=approved task=task_123 -->\nApproved`,
        created_at: '2026-05-14T00:00:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(true);
  });

  it('rejects spoofed, stale, or non-leading attestations', () => {
    const validMarker = `<!-- cenetex-review-attestation:v1 head=${HEAD_SHA} decision=approved task=task_123 -->`;
    expect(hasCurrentBotAttestation([
      {
        id: 10,
        body: validMarker,
        created_at: '2026-05-14T00:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
      {
        id: 11,
        body: `Text before marker\n${validMarker}`,
        created_at: '2026-05-14T00:01:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
      {
        id: 12,
        body: `<!-- cenetex-review-attestation:v1 head=${'b'.repeat(40)} decision=approved task=task_123 -->`,
        created_at: '2026-05-14T00:02:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(false);
  });

  it('rejects an approval superseded by a later exact-head error', () => {
    expect(hasCurrentBotAttestation([
      {
        id: 10,
        body: `<!-- cenetex-review-attestation:v1 head=${HEAD_SHA} decision=approved task=task_123 -->`,
        created_at: '2026-05-14T00:00:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
      {
        id: 11,
        body: `<!-- cenetex-review-attestation:v1 head=${HEAD_SHA} decision=error task=task_456 -->`,
        created_at: '2026-05-14T00:01:00Z',
        user: { login: 'cenetex[bot]', type: 'Bot' },
      },
    ], BOT_LOGINS, HEAD_SHA)).toBe(false);
  });
});
