import { DEFAULT_MONITORED_REPOS } from "../lib/monitored-repos";

describe("default monitored repositories", () => {
  it("includes the Braid, ilXyr, and Zero repositories", () => {
    expect(DEFAULT_MONITORED_REPOS).toContain("cenetex/braid");
    expect(DEFAULT_MONITORED_REPOS).toContain("cenetex/ilXyr");
    expect(DEFAULT_MONITORED_REPOS).toContain(
      "atimics/zero-grounded-literary-lm"
    );
  });

  it("does not contain duplicate repository slugs", () => {
    expect(new Set(DEFAULT_MONITORED_REPOS).size).toBe(
      DEFAULT_MONITORED_REPOS.length
    );
  });
});
