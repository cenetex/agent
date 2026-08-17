import { hasBlockingAutoMergeLabel } from '../lib/review-policy';

describe('review policy', () => {
  it('blocks auto-merge for pause and human-required labels', () => {
    expect(hasBlockingAutoMergeLabel(['review:approved'])).toBe(false);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'pause-agent'])).toBe(true);
    expect(hasBlockingAutoMergeLabel(['review:approved', 'review:human-required'])).toBe(true);
  });
});
