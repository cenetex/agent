export default function Features() {
  const features = [
    {
      title: "Bug Fixes",
      description: "Automatically identify and fix bugs in your codebase",
      icon: "🐛",
    },
    {
      title: "Feature Implementation",
      description: "Implement new features based on issue descriptions",
      icon: "✨",
    },
    {
      title: "Code Review",
      description: "Intelligent code review and feedback on pull requests",
      icon: "👁️",
    },
    {
      title: "Credit System",
      description: "Flexible credit-based pricing for your needs",
      icon: "💳",
    },
    {
      title: "GitHub Native",
      description: "Seamlessly integrated with GitHub labels and workflows",
      icon: "🐙",
    },
    {
      title: "Configurable",
      description: "Customize behavior with .github/AGENT.md per repository",
      icon: "⚙️",
    },
  ];

  return (
    <section className="py-16 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-12">
          Features
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          {features.map((feature, idx) => (
            <div
              key={idx}
              className="p-6 border border-gray-200 rounded-lg hover:shadow-lg transition"
            >
              <div className="text-4xl mb-4">{feature.icon}</div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-gray-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
