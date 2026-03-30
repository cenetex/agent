export const metadata = {
  title: 'Troubleshooting - Agent',
}

export default function Troubleshooting() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Troubleshooting</h1>

        <div className="prose prose-lg max-w-none space-y-8">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Common Issues</h2>

            <div className="space-y-6">
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-2">Agent Not Triggering</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> You added the <code>agent</code> label but nothing happened.</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>Verify the app is installed on your repository</li>
                  <li>Check that the <code>agent</code> label exists (create it if needed)</li>
                  <li>Check GitHub Actions logs for any errors</li>
                  <li>Try removing and re-adding the label</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Insufficient Credits</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> Task failed with "Insufficient credits" error.</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>Check your credit balance in the dashboard</li>
                  <li>Use a cheaper model (Haiku instead of Sonnet)</li>
                  <li>Break large tasks into smaller issues</li>
                  <li>Wait for payment system to purchase more credits</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Task Timeout</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> Task failed with "Task timeout after 30 minutes".</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>The task is too complex to complete in 30 minutes</li>
                  <li>Break the issue into smaller, focused subtasks</li>
                  <li>Provide more context and examples in the issue description</li>
                  <li>Retry with a simpler version of the task</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Poor Code Quality</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> The generated code doesn't meet your standards.</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>Update <code>.github/CLAUDE.md</code> with your architecture and guidelines</li>
                  <li>Include explicit requirements in the issue</li>
                  <li>Use a better model (Sonnet or Opus instead of Haiku)</li>
                  <li>Reference similar code in your repository</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Tests Failing</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> Generated code doesn't pass your test suite.</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>Include test requirements in the issue description</li>
                  <li>Provide examples of existing tests in <code>.github/CLAUDE.md</code></li>
                  <li>Specify the expected test format and framework</li>
                  <li>Run tests manually and re-add the <code>agent</code> label with the test output</li>
                </ul>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-xl font-semibold text-gray-900 mb-3">Webhook Issues</h3>
                <p className="text-gray-700 mb-3"><strong>Problem:</strong> The webhook isn't firing or updating labels.</p>
                <p className="text-gray-700"><strong>Solution:</strong></p>
                <ul>
                  <li>Check the webhook configuration in repository settings</li>
                  <li>Verify recent deliveries tab for errors</li>
                  <li>Re-install the app and check permissions</li>
                  <li>Check CloudWatch logs for Lambda errors</li>
                </ul>
              </div>
            </div>
          </div>

          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Debugging</h2>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Check CloudWatch Logs</h3>
              <p className="text-gray-700 mb-3">View detailed logs for debugging:</p>
              <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`aws logs tail /aws/lambda/GitHubAgentStack-WebhookHandler --follow`}
              </pre>
              <p className="text-gray-700 mt-3">Or navigate to AWS Console → CloudWatch → Log Groups</p>
            </div>

            <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
              <h3 className="font-semibold text-gray-900 mb-3">Check GitHub Webhook Deliveries</h3>
              <p className="text-gray-700">Navigate to your repository settings → Webhooks to see delivery logs</p>
            </div>

            <div className="bg-purple-50 border border-purple-200 rounded-lg p-6">
              <h3 className="font-semibold text-gray-900 mb-3">Enable Verbose Logging</h3>
              <p className="text-gray-700 mb-3">Set in your issue description:</p>
              <pre className="bg-gray-100 p-3 rounded text-sm">
{`Debug: true
Verbose: true`}
              </pre>
            </div>
          </div>

          <div>
            <h2 className="text-2xl font-bold text-gray-900 mb-4">Getting Help</h2>
            <ul>
              <li>Check the <a href="/docs">documentation</a> for detailed guides</li>
              <li>Search existing issues on GitHub</li>
              <li>Open a new issue with the <code>help</code> label for assistance</li>
              <li>Contact support (coming soon)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
