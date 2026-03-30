export default function HowItWorks() {
  const steps = [
    {
      number: "1",
      title: "Label Issue",
      description: "Add the 'agent' label to any GitHub issue",
    },
    {
      number: "2",
      title: "Agent Works",
      description: "Claude Code analyzes and implements the solution",
    },
    {
      number: "3",
      title: "Create PR",
      description: "Agent creates a pull request with the implementation",
    },
    {
      number: "4",
      title: "Review & Merge",
      description: "Review the changes and merge when ready",
    },
  ];

  return (
    <section className="py-16 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-12">
          How It Works
        </h2>
        <div className="grid md:grid-cols-4 gap-8">
          {steps.map((step, idx) => (
            <div key={idx} className="relative">
              <div className="flex items-center justify-center h-12 w-12 rounded-full bg-blue-600 text-white font-bold mb-4">
                {step.number}
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {step.title}
              </h3>
              <p className="text-gray-600">{step.description}</p>
              {idx < 3 && (
                <div className="hidden md:block absolute top-6 -right-4 text-gray-300 text-2xl">
                  →
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
