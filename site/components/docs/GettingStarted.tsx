export default function GettingStarted() {
  return (
    <div className="space-y-12">
      <section id="installation">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Installation</h2>
        <p className="text-gray-600 mb-4">
          The Agent GitHub App is available for installation on your GitHub repositories.
        </p>
        <ol className="list-decimal list-inside space-y-2 text-gray-600">
          <li>
            Visit the{" "}
            <a
              href="https://github.com/apps/cenetex-coding-agent"
              className="text-blue-600 hover:text-blue-700"
            >
              Agent GitHub App
            </a>
          </li>
          <li>Click "Install"</li>
          <li>Select the repositories where you want to enable the Agent</li>
          <li>Grant the required permissions</li>
          <li>You{"'"}re ready to go!</li>
        </ol>
      </section>

      <section id="first-task">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Your First Task</h2>
        <p className="text-gray-600 mb-4">
          To trigger the Agent on an issue or pull request:
        </p>
        <ol className="list-decimal list-inside space-y-2 text-gray-600 mb-6">
          <li>Create a new GitHub issue</li>
          <li>Add the <code>agent</code> label</li>
          <li>The Agent will automatically start processing</li>
          <li>Watch as it creates a PR with the implementation</li>
        </ol>
        <div className="bg-gray-100 p-4 rounded">
          <p className="text-sm font-semibold text-gray-700 mb-2">Example Issue:</p>
          <div className="text-sm text-gray-600 space-y-2">
            <p>
              <strong>Title:</strong> Add validation to email input
            </p>
            <p>
              <strong>Description:</strong> The email field in the signup form should
              validate that the input is a valid email address before submission.
            </p>
            <p>
              <strong>Labels:</strong> agent, bug
            </p>
          </div>
        </div>
      </section>

      <section id="task-lifecycle">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Task Lifecycle</h2>
        <p className="text-gray-600 mb-4">
          When you label an issue with <code>agent</code>, it goes through these stages:
        </p>
        <div className="space-y-4">
          <div className="border-l-4 border-blue-600 pl-4">
            <h3 className="font-semibold text-gray-900">Running</h3>
            <p className="text-gray-600 text-sm">
              The Agent is analyzing the issue and implementing the solution.
              (Status: <code>agent:running</code>)
            </p>
          </div>
          <div className="border-l-4 border-yellow-500 pl-4">
            <h3 className="font-semibold text-gray-900">Waiting</h3>
            <p className="text-gray-600 text-sm">
              The Agent needs clarification or more information. Add the label again
              after providing clarification. (Status: <code>agent:waiting</code>)
            </p>
          </div>
          <div className="border-l-4 border-green-600 pl-4">
            <h3 className="font-semibold text-gray-900">Succeeded</h3>
            <p className="text-gray-600 text-sm">
              The Agent completed the task and created a PR.
              (Status: <code>agent:succeeded</code>)
            </p>
          </div>
          <div className="border-l-4 border-red-600 pl-4">
            <h3 className="font-semibold text-gray-900">Failed</h3>
            <p className="text-gray-600 text-sm">
              The task encountered an error. Check the error details and retry by
              adding the label again. (Status: <code>agent:failed</code>)
            </p>
          </div>
        </div>
      </section>

      <section id="labels">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Labels & Status</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Label</th>
                <th className="px-4 py-2 text-left font-semibold">Purpose</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="px-4 py-2 font-mono text-blue-600">agent</td>
                <td className="px-4 py-2">Trigger the Agent to work on this issue</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-blue-600">agent:running</td>
                <td className="px-4 py-2">Agent is currently processing</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-yellow-600">agent:waiting</td>
                <td className="px-4 py-2">Agent is waiting for more information</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-green-600">agent:succeeded</td>
                <td className="px-4 py-2">Task completed successfully</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-mono text-red-600">agent:failed</td>
                <td className="px-4 py-2">Task failed, check error details</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="credits">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Credit System</h2>
        <p className="text-gray-600 mb-4">
          The Agent uses a credit-based billing system. Each task consumes credits based
          on the model used.
        </p>
        <div className="bg-blue-50 p-4 rounded mb-6">
          <h3 className="font-semibold text-gray-900 mb-2">Default Model Allocation</h3>
          <ul className="text-sm text-gray-600 space-y-1">
            <li>• Issues: Claude Haiku (4 credits)</li>
            <li>• Pull Requests: Claude Sonnet (12 credits)</li>
            <li>• Planning: Claude Haiku (4 credits)</li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 mb-3">Credits by Model</h3>
          <div className="grid md:grid-cols-3 gap-4">
            <div className="border border-gray-200 p-4 rounded">
              <div className="font-semibold text-gray-900">Claude Haiku 4.5</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">4 credits</div>
            </div>
            <div className="border border-gray-200 p-4 rounded">
              <div className="font-semibold text-gray-900">Claude Sonnet 4.6</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">12 credits</div>
            </div>
            <div className="border border-gray-200 p-4 rounded">
              <div className="font-semibold text-gray-900">Claude Opus 4.6</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">20 credits</div>
            </div>
          </div>
        </div>
        <p className="text-gray-600 text-sm mt-6">
          All new repositories receive 100 free credits to get started. Failed tasks are
          not charged.
        </p>
      </section>

      <section id="agent-md">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">AGENT.md Configuration</h2>
        <p className="text-gray-600 mb-4">
          Create a <code>.github/AGENT.md</code> file in your repository to configure the
          Agent{"'"}s behavior on a per-repo basis.
        </p>
        <pre className="bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto text-sm">
          {`# Agent Configuration

## Models
Use a specific model for all tasks:
\`\`\`
model: anthropic/claude-opus-4-6
\`\`\`

## Behavior
Custom instructions and constraints for your repository can be added here.`}
        </pre>
      </section>
    </div>
  );
}
