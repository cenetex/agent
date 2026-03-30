export const metadata = {
  title: 'Task Lifecycle - Agent',
}

export default function TaskLifecycle() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Task Lifecycle</h1>

        <div className="prose prose-lg max-w-none">
          <h2>Task States</h2>
          <p>
            Each agent task has a lifecycle with different states indicated by labels on the GitHub issue or PR:
          </p>

          <div className="space-y-6 my-8">
            <div className="bg-blue-50 border-l-4 border-blue-500 p-4">
              <h3 className="font-semibold text-gray-900 mb-2">🔷 agent</h3>
              <p className="text-gray-700">
                <strong>Trigger label:</strong> Add this label to activate the agent on an issue or PR.
                The agent automatically removes this and transitions to <code>agent:running</code>.
              </p>
            </div>

            <div className="bg-purple-50 border-l-4 border-purple-500 p-4">
              <h3 className="font-semibold text-gray-900 mb-2">🟣 agent:running</h3>
              <p className="text-gray-700">
                The agent is currently processing the task. This may take anywhere from a few seconds
                to the 30-minute timeout. Check CloudWatch logs for progress.
              </p>
            </div>

            <div className="bg-green-50 border-l-4 border-green-500 p-4">
              <h3 className="font-semibold text-gray-900 mb-2">✅ agent:succeeded</h3>
              <p className="text-gray-700">
                The agent completed the task successfully. For issues, a PR has been created.
                For PRs, review comments have been added. Credits were deducted.
              </p>
            </div>

            <div className="bg-red-50 border-l-4 border-red-500 p-4">
              <h3 className="font-semibold text-gray-900 mb-2">❌ agent:failed</h3>
              <p className="text-gray-700">
                The agent encountered an error and could not complete the task.
                A comment with error details is posted. No credits are deducted.
              </p>
            </div>

            <div className="bg-yellow-50 border-l-4 border-yellow-500 p-4">
              <h3 className="font-semibold text-gray-900 mb-2">⏸️ agent:waiting</h3>
              <p className="text-gray-700">
                The agent needs more information to proceed. A comment with clarification
                requests is posted. Re-add the <code>agent</code> label to continue.
              </p>
            </div>
          </div>

          <h2>Workflow Diagram</h2>
          <pre className="bg-gray-100 p-4 rounded text-sm overflow-x-auto my-8">
{`Add agent label
  ↓
agent:running
  ├→ Analyze issue
  ├→ Write code
  ├→ Create PR/Review
  ↓
agent:succeeded (credits deducted) OR agent:failed (no charge) OR agent:waiting

Retry after feedback:
  Re-add agent label → agent:running → ...`}
          </pre>

          <h2>Retry Behavior</h2>
          <p>
            You can retry failed tasks or continue waiting tasks by re-adding the
            <code>agent</code> label:
          </p>
          <ul>
            <li><strong>Failed tasks:</strong> Re-add <code>agent</code> to retry the task</li>
            <li><strong>Waiting tasks:</strong> Provide clarification in a comment, then re-add <code>agent</code></li>
            <li><strong>Succeeded tasks:</strong> The task is complete; create a new issue for new work</li>
          </ul>

          <h2>Timeout and Limits</h2>
          <ul>
            <li><strong>30-minute timeout:</strong> Agent tasks have a 30-minute safety limit</li>
            <li><strong>Long-running tasks:</strong> Break large features into smaller issues if needed</li>
            <li><strong>Resource limits:</strong> Agent runs with 2GB memory and 1 vCPU in Fargate</li>
          </ul>

          <h2>Monitoring Task Progress</h2>
          <p>
            Monitor your task in real-time:
          </p>
          <ol>
            <li>Check the GitHub issue for the <code>agent:running</code> label</li>
            <li>View CloudWatch logs using: <code>aws logs tail /aws/lambda/GitHubAgentStack-WebhookHandler --follow</code></li>
            <li>Wait for the <code>agent:succeeded</code> or <code>agent:failed</code> label</li>
            <li>For succeeded tasks, review the PR created by the agent</li>
          </ol>
        </div>
      </div>
    </div>
  )
}
