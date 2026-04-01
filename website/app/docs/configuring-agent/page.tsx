export const metadata = {
  title: 'Configuring Agent - Agent',
}

export default function ConfiguringAgent() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Configuring Agent</h1>

        <div className="prose prose-lg max-w-none">
          <h2>Repository Configuration Files</h2>
          <p>
            Customize agent behavior by creating configuration files in your repository:
          </p>

          <h2>AGENT.md</h2>
          <p>
            Create <code>.github/AGENT.md</code> to customize behavior for your repository:
          </p>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md

## Model Configuration

# Default model for all tasks
model: anthropic/claude-opus-4-6

# Specific models for different task types
model-for-issues: anthropic/claude-sonnet-4-6
model-for-reviews: anthropic/claude-haiku-4-5

## Behavior

# Automatically review PRs labeled with \`review\`
auto-review: true

# Require human approval before merging PRs (coming soon)
require-approval: false

## Guidelines

# Custom system prompt or guidelines for the agent
guidelines: |
  - Always add TypeScript types
  - Include tests for new functionality
  - Follow the repository's coding standards`}
          </pre>

          <h2>CLAUDE.md</h2>
          <p>
            Create <code>.github/CLAUDE.md</code> to provide additional context and instructions:
          </p>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/CLAUDE.md

## Project Context

**Project Name:** MyApp
**Tech Stack:** TypeScript, React, Express, PostgreSQL

## Architecture Overview

- Frontend: React components in \`src/components/\`
- Backend: Express API in \`src/api/\`
- Database: PostgreSQL with migrations in \`db/migrations/\`

## Code Style

- Use TypeScript strict mode
- 80-character line limit for comments
- Test coverage minimum: 80%
- Use ESLint and Prettier for formatting

## Development Setup

\`\`\`bash
npm install
npm run dev
npm test
\`\`\`

## Key Files

- \`package.json\` - Dependencies and scripts
- \`tsconfig.json\` - TypeScript configuration
- \`src/\` - Source code
- \`tests/\` - Test files

## Common Patterns

- Middleware in \`src/middleware/\`
- Database models in \`src/models/\`
- API routes in \`src/routes/\`
- Tests colocated with source files as \`.test.ts\``}
          </pre>

          <h2>Model Selection</h2>
          <p>
            Choose the right model based on task complexity and budget:
          </p>
          <ul>
            <li><strong>Haiku:</strong> Bug fixes, simple features, low cost</li>
            <li><strong>Sonnet:</strong> Balanced for most tasks (recommended default)</li>
            <li><strong>Opus:</strong> Complex features, architecture decisions, high quality</li>
          </ul>

          <h2>Example Configurations</h2>
          <h3>Budget-Conscious Setup</h3>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md

model: anthropic/claude-haiku-4-5
model-for-reviews: anthropic/claude-haiku-4-5

# Good for: Maximizing task count with free tier`}
          </pre>

          <h3>Quality-Focused Setup</h3>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md

model: anthropic/claude-opus-4-6
auto-review: true

# Good for: High-quality implementations and automatic reviews`}
          </pre>

          <h3>Mixed Approach</h3>
          <pre className="bg-gray-100 p-4 rounded overflow-x-auto">
{`# .github/AGENT.md

# Use Sonnet for most work
model: anthropic/claude-sonnet-4-6

# Use Opus only for complex features (manually labeled)
model-for-complex: anthropic/claude-opus-4-6

# Use Haiku for reviews (fast and cheap)
model-for-reviews: anthropic/claude-haiku-4-5`}
          </pre>

          <h2>Best Practices</h2>
          <ul>
            <li>Set <code>model-for-reviews</code> to Haiku to reduce costs on PR reviews</li>
            <li>Include architecture context in CLAUDE.md for better results</li>
            <li>Update configuration files as your project evolves</li>
            <li>Use custom guidelines to enforce coding standards</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
