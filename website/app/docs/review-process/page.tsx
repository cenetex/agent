export const metadata = {
  title: 'Review Process - Agent',
}

export default function ReviewProcess() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Review Process</h1>

        <div className="prose prose-lg max-w-none">
          <h2>Auto-Review Feature</h2>
          <p>
            The agent can automatically review pull requests in your repository. This helps ensure
            code quality and catches issues before human review.
          </p>

          <h2>How It Works</h2>
          <ol>
            <li>Enable auto-review in your <code>.github/AGENT.md</code></li>
            <li>Label a PR with <code>review</code> or just push a PR to a monitored repository</li>
            <li>The agent runs code review checks every 15 minutes</li>
            <li>Agent leaves detailed comments on problematic lines</li>
            <li>You can request changes or approve based on feedback</li>
          </ol>

          <h2>Enabling Auto-Review</h2>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md

auto-review: true
model-for-reviews: anthropic/claude-haiku-4-5`}
          </pre>

          <h2>Review Capabilities</h2>
          <p>
            The agent can review PRs for:
          </p>
          <ul>
            <li>Code style and formatting violations</li>
            <li>Type safety and Type errors</li>
            <li>Missing error handling</li>
            <li>Security vulnerabilities (basic)</li>
            <li>Performance issues</li>
            <li>Best practices and anti-patterns</li>
            <li>Test coverage gaps</li>
            <li>Documentation completeness</li>
          </ul>

          <h2>Review Comments</h2>
          <p>
            The agent leaves comments in the review with:
          </p>
          <ul>
            <li><strong>Severity:</strong> Info, Warning, Error</li>
            <li><strong>Category:</strong> Style, Security, Performance, Testing, etc.</li>
            <li><strong>Suggestion:</strong> How to fix the issue</li>
            <li><strong>Example:</strong> Code example showing the fix</li>
          </ul>

          <h2>Review Example</h2>
          <pre className="bg-gray-100 p-4 rounded text-sm overflow-x-auto">
{`// Code being reviewed
async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`);
  const data = await response.json();
  return data;
}

// Agent Comment:
🚨 Missing error handling
- Line 3: response.ok check is missing
- Line 3: response.json() may throw if response is not JSON

Suggestion: Add error handling
\`\`\`typescript
async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`);
  if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
  const data = await response.json();
  return data;
}
\`\`\``}
          </pre>

          <h2>Monitored Repositories</h2>
          <p>
            Auto-review is enabled on these public repositories:
          </p>
          <ul>
            <li>cenetex/aws-swarm</li>
            <li>cenetex/kyro</li>
            <li>cenetex/raticross</li>
            <li>cenetex/ratibot</li>
            <li>cenetex/litigation</li>
            <li>cenetex/agent</li>
            <li>cenetex/governance</li>
          </ul>

          <h2>Customizing Reviews</h2>
          <p>
            Use <code>.github/CLAUDE.md</code> to provide coding standards and guidelines:
          </p>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/CLAUDE.md

## Review Guidelines

- Require TypeScript strict mode
- Minimum 80% test coverage
- No console.log in production code
- Use \`const\` by default, \`let\` if needed
- Comments should explain WHY, not WHAT
- Imports must be sorted alphabetically`}
          </pre>

          <h2>Limitations</h2>
          <ul>
            <li>Reviews are recommendations, not requirements</li>
            <li>Always use human judgment for final approval</li>
            <li>Security review is basic; use dedicated tools for compliance</li>
            <li>Complex architectural reviews may require human input</li>
          </ul>

          <h2>Opting Out</h2>
          <p>
            To disable auto-review for a specific PR:
          </p>
          <ul>
            <li>Remove the <code>review</code> label</li>
            <li>Set <code>auto-review: false</code> in .github/AGENT.md</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
