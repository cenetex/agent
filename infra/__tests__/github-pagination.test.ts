import {
  collectGitHubPages,
  GITHUB_PAGE_SIZE,
} from '../lib/github-pagination';

describe('collectGitHubPages', () => {
  it('collects every page until GitHub returns a short page', async () => {
    const calls: Array<[number, number]> = [];
    const result = await collectGitHubPages(async (page, perPage) => {
      calls.push([page, perPage]);
      if (page === 1) {
        return Array.from({ length: GITHUB_PAGE_SIZE }, (_, index) => index);
      }
      return [100, 101];
    });

    expect(result).toHaveLength(102);
    expect(calls).toEqual([
      [1, GITHUB_PAGE_SIZE],
      [2, GITHUB_PAGE_SIZE],
    ]);
  });

  it('fails closed rather than accepting a truncated policy input', async () => {
    await expect(
      collectGitHubPages(
        async () => Array.from({ length: GITHUB_PAGE_SIZE }, (_, index) => index),
        2
      )
    ).rejects.toThrow('refusing an incomplete result');
  });

  it('rejects invalid page caps', async () => {
    await expect(collectGitHubPages(async () => [], 0)).rejects.toThrow(
      'positive integer'
    );
  });
});
