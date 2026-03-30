export function HowItWorks() {
  const steps = [
    {
      number: '1',
      title: 'Create Issue',
      description: 'Write an issue describing what needs to be fixed or built',
    },
    {
      number: '2',
      title: 'Label Issue',
      description: 'Add the `agent` label to trigger the autonomous agent',
    },
    {
      number: '3',
      title: 'Agent Works',
      description: 'The agent analyzes the issue and writes code to fix it',
    },
    {
      number: '4',
      title: 'Create PR',
      description: 'A pull request is created with the implementation and a clear description',
    },
    {
      number: '5',
      title: 'Review',
      description: 'Review the code changes and test locally if needed',
    },
    {
      number: '6',
      title: 'Merge',
      description: 'Approve and merge the PR to deploy your changes',
    },
  ]

  return (
    <div className="py-20 bg-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-4xl font-bold text-center mb-16">How It Works</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {steps.map((step, index) => (
            <div key={index} className="relative">
              <div className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white rounded-full w-12 h-12 flex items-center justify-center font-bold text-lg mb-4">
                {step.number}
              </div>
              <h3 className="text-xl font-bold mb-2">{step.title}</h3>
              <p className="text-gray-600">{step.description}</p>

              {index < steps.length - 1 && (
                <div className="absolute -bottom-8 right-0 text-gray-300 text-3xl hidden lg:block">
                  →
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-16 bg-gray-50 rounded-lg p-8">
          <h3 className="text-2xl font-bold mb-4">Example Workflow</h3>
          <div className="space-y-4 font-mono text-sm">
            <p className="text-gray-700">
              <span className="text-blue-600">Issue:</span> "Fix authentication bug where login fails for emails with plus sign"
            </p>
            <p className="text-gray-700">
              <span className="text-green-600">→ Add label:</span> agent
            </p>
            <p className="text-gray-700">
              <span className="text-purple-600">→ Agent creates:</span> PR with fix to email validation
            </p>
            <p className="text-gray-700">
              <span className="text-orange-600">→ Result:</span> Feature working, bug fixed, deployed to production
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
