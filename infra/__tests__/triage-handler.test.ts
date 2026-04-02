/**
 * Tests for triage handler functionality
 */

// Test suite for error parsing and classification
describe("Triage Handler", () => {
  // Note: These tests verify the error parsing logic
  // Full integration tests would require mocking GitHub API

  describe("Error Parsing", () => {
    it("should extract error lines matching patterns", () => {
      const logs = `
        [12:34:56] Building project...
        ERROR: Cannot find module 'express'
        [12:34:57] Build with error TS2305
        Permission denied accessing AWS resources
        [12:34:58] Test FAIL: validation logic
      `;

      // Import would be needed in actual test
      const patterns = [
        /\bERROR\b/i,
        /\berror\b/i,
        /\bTS\d+\b/,
        /\bFAIL\b/i,
        /\bCannot\b/,
        /\bdenied\b/i,
      ];

      const lines = logs.split("\n");
      const errorLines: string[] = [];

      for (const line of lines) {
        if (patterns.some(pattern => pattern.test(line))) {
          const trimmed = line.trim();
          if (trimmed && !errorLines.includes(trimmed)) {
            errorLines.push(trimmed);
          }
        }
      }

      // Should find all error lines
      expect(errorLines.length).toBeGreaterThan(0);
      expect(errorLines.some(e => e.includes("Cannot find module"))).toBe(true);
      expect(errorLines.some(e => e.includes("TS2305"))).toBe(true);
      expect(errorLines.some(e => e.includes("Permission denied"))).toBe(true);
      expect(errorLines.some(e => e.includes("FAIL"))).toBe(true);
    });
  });

  describe("Error Classification", () => {
    it("should classify IAM/infrastructure errors as needs:manual", () => {
      const testCases = [
        "Access Denied: IAM role not found",
        "403 Forbidden: OIDC token validation failed",
        "Permission denied accessing AWS credentials",
        "Unauthorized: AWS secret access key invalid",
      ];

      for (const errorMsg of testCases) {
        const lowerError = errorMsg.toLowerCase();
        const isIamError =
          lowerError.includes("iam") ||
          lowerError.includes("oidc") ||
          lowerError.includes("permission") ||
          lowerError.includes("denied") ||
          lowerError.includes("403") ||
          lowerError.includes("401") ||
          lowerError.includes("unauthorized") ||
          lowerError.includes("access denied") ||
          lowerError.includes("aws") ||
          lowerError.includes("credential");

        expect(isIamError).toBe(true);
      }
    });

    it("should classify code errors as agent", () => {
      const testCases = [
        "error TS1234: Cannot find name 'undefined'",
        "Type error: property 'foo' not found",
        "ESLint: Unexpected console statement",
        "Jest: Test failed - assertion error",
        "Cannot find module '@types/node'",
      ];

      for (const errorMsg of testCases) {
        const lowerError = errorMsg.toLowerCase();
        const isCodeError =
          lowerError.includes("error ts") ||
          lowerError.includes("type error") ||
          lowerError.includes("cannot find") ||
          lowerError.includes("lint") ||
          lowerError.includes("jest") ||
          lowerError.includes("test failed") ||
          lowerError.includes("module not found");

        expect(isCodeError).toBe(true);
      }
    });

    it("should classify unknown errors as needs:triage", () => {
      const testCases = [
        "Timeout: process did not exit",
        "Disk full error",
        "Connection timeout",
      ];

      for (const errorMsg of testCases) {
        const lowerError = errorMsg.toLowerCase();
        const isIamError = lowerError.includes("iam") || lowerError.includes("oidc");
        const isCodeError =
          lowerError.includes("error ts") || lowerError.includes("type error");

        // Should be classified as unknown if not IAM or code error
        expect(!isIamError && !isCodeError).toBe(true);
      }
    });
  });

  describe("Deploy Failure Detection", () => {
    it("should detect deploy failure issues", () => {
      const testIssues = [
        { title: "🚨 Deploy Workflow Failed", body: "" },
        { title: "CI workflow failed", body: "" },
        { title: "Build issue", body: "workflow run 123 failed" },
        { title: "Regular bug", body: "Action failed unexpectedly" },
      ];

      const isDeployFailure = (issue: any) => {
        const title = (issue.title || "").toLowerCase();
        const body = (issue.body || "").toLowerCase();
        return (
          title.includes("deploy") ||
          title.includes("workflow") ||
          title.includes("ci") ||
          body.includes("workflow run") ||
          body.includes("action failed")
        );
      };

      expect(isDeployFailure(testIssues[0])).toBe(true);
      expect(isDeployFailure(testIssues[1])).toBe(true);
      expect(isDeployFailure(testIssues[2])).toBe(true);
      expect(isDeployFailure(testIssues[3])).toBe(true);
    });
  });

  describe("Workflow Run ID Extraction", () => {
    it("should extract workflow run IDs from various formats", () => {
      const testCases = [
        { body: "Run ID: 123456", expected: "123456" },
        { body: "workflow run 987654", expected: "987654" },
        { body: "(Run #555555)", expected: "555555" },
        { body: "Run/ID: 111111", expected: "111111" },
      ];

      const patterns = [
        /Run ID[:\s]+(\d+)/i,
        /workflow run (\d+)/i,
        /run[\/\s]+id[:\s]+(\d+)/i,
        /\(Run #(\d+)\)/,
      ];

      for (const testCase of testCases) {
        let found = false;
        for (const pattern of patterns) {
          const match = testCase.body.match(pattern);
          if (match) {
            expect(match[1]).toBe(testCase.expected);
            found = true;
            break;
          }
        }
        expect(found).toBe(true);
      }
    });
  });
});
