import {
  hasBlockingAutoMergeLabel,
  hasCurrentBotApproval,
} from '../lib/review-policy';

const BOT_LOGINS = ['cenetex[bot]', 'github-agent[bot]'];
const HEAD_SHA = 'abc123';

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
});
