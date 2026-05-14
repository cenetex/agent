import {
  hasBlockingAutoMergeLabel,
  hasCurrentHumanApproval,
  isHumanApprovalReview,
} from '../lib/review-policy';

describe('review policy', () => {
  it('requires a human approved review', () => {
    expect(isHumanApprovalReview({
      state: 'APPROVED',
      user: { login: 'alice', type: 'User' },
    })).toBe(true);

    expect(isHumanApprovalReview({
      state: 'CHANGES_REQUESTED',
      user: { login: 'alice', type: 'User' },
    })).toBe(false);

    expect(isHumanApprovalReview({
      state: 'APPROVED',
      user: { login: 'github-actions[bot]', type: 'Bot' },
    })).toBe(false);
  });

  it('blocks auto-merge for pause and human-required labels', () => {
    expect(hasBlockingAutoMergeLabel(['review:approved'])).toBe(false);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'pause-agent'])).toBe(true);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'review:human-required'])).toBe(true);
  });

  it('uses the latest human review states for merge eligibility', () => {
    expect(hasCurrentHumanApproval([
      {
        state: 'APPROVED',
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
    ])).toBe(true);

    expect(hasCurrentHumanApproval([
      {
        state: 'APPROVED',
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-05-14T01:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
    ])).toBe(false);

    expect(hasCurrentHumanApproval([
      {
        state: 'APPROVED',
        submitted_at: '2026-05-14T00:00:00Z',
        user: { login: 'alice', type: 'User' },
      },
      {
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-05-14T01:00:00Z',
        user: { login: 'bob', type: 'User' },
      },
    ])).toBe(false);
  });
});
