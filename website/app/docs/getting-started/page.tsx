export const metadata = {
  title: 'Getting Started - Agent',
}

export default function GettingStarted() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Getting Started</h1>

        <div className="prose prose-lg max-w-none">
          <h2>1. Install the GitHub App</h2>
          <p>
            Click the Install button on the home page to authorize the Agent app on your repository.
            This will give the app permission to:
          </p>
          <ul>
            <li>Read issues and pull requests</li>
            <li>Create branches and push commits</li>
            <li>Create pull requests</li>
            <li>Add labels and comments</li>
          </ul>

          <h2>2. Label an Issue</h2>
          <p>
            After installation, create or select an issue in your repository. Add the <code>agent</code> label
            to trigger the agent:
          </p>
          <ol>
            <li>Open an issue describing a bug fix or feature to implement</li>
            <li>Add the <code>agent</code> label</li>
            <li>The agent will automatically be triggered</li>
          </ol>

          <h2>3. Agent Processing</h2>
          <p>
            The agent will:
          </p>
          <ol>
            <li>Remove the <code>agent</code> label and add <code>agent:running</code></li>
            <li>Analyze the issue and understand the requirements</li>
            <li>Write code to fix or implement the feature</li>
            <li>Create a new branch with the changes</li>
            <li>Create a pull request with a detailed description</li>
            <li>Add the <code>agent:succeeded</code> label when complete</li>
          </ol>

          <h2>4. Review and Merge</h2>
          <p>
            The pull request created by the agent is ready for your review:
          </p>
          <ul>
            <li>Review the code and test locally if needed</li>
            <li>Request changes or approve</li>
            <li>Merge the PR when satisfied</li>
          </ul>

          <h2>Credits</h2>
          <p>
            Each task deducts credits based on the AI model used. New repositories receive 100 free credits.
            See the <a href="/docs/credit-system">Credit System</a> documentation for details on pricing.
          </p>
        </div>

        <div className="mt-12 bg-green-50 border border-green-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">💡 Pro Tips</h3>
          <ul className="text-gray-700 space-y-2">
            <li>• Write clear issue titles and descriptions for better results</li>
            <li>• Include context about existing code and architecture</li>
            <li>• Use AGENT.md to customize agent behavior for your repo</li>
            <li>• Check CloudWatch logs if a task fails</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
