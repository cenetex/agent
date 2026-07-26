export const GITHUB_PAGE_SIZE = 100;
export const DEFAULT_MAX_GITHUB_PAGES = 10;

/**
 * Collect every page from a GitHub list endpoint.
 *
 * A full final page is ambiguous: there may be another page. Hitting the
 * configured cap therefore fails closed instead of silently returning an
 * incomplete policy input.
 */
export async function collectGitHubPages<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
  maxPages: number = DEFAULT_MAX_GITHUB_PAGES
): Promise<T[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('maxPages must be a positive integer');
  }

  const items: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const pageItems = await fetchPage(page, GITHUB_PAGE_SIZE);
    items.push(...pageItems);

    if (pageItems.length < GITHUB_PAGE_SIZE) {
      return items;
    }
  }

  throw new Error(
    `GitHub pagination exceeded ${maxPages} pages; refusing an incomplete result`
  );
}
