export default function Pricing() {
  const plans = [
    {
      name: "Free",
      price: "$0",
      credits: "100 credits",
      description: "Perfect to get started",
      features: [
        "100 free credits",
        "~25 Haiku tasks",
        "Community support",
      ],
    },
    {
      name: "Pro",
      price: "$20",
      period: "/month",
      credits: "500+ credits",
      description: "For active teams",
      features: [
        "500 credits/month",
        "Priority support",
        "Advanced configuration",
        "API access",
      ],
      highlighted: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      credits: "Unlimited",
      description: "For large teams",
      features: [
        "Custom credit allocation",
        "Dedicated support",
        "SLA guarantee",
        "Custom models",
      ],
    },
  ];

  return (
    <section id="pricing" className="py-16 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">
          Simple, Transparent Pricing
        </h2>
        <p className="text-center text-gray-600 mb-12 max-w-2xl mx-auto">
          Credit-based billing. Pay only for what you use. Each model tier costs different credits.
        </p>

        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((plan, idx) => (
            <div
              key={idx}
              className={`rounded-lg p-8 ${
                plan.highlighted
                  ? "bg-blue-600 text-white ring-2 ring-blue-600 scale-105"
                  : "bg-white border border-gray-200"
              }`}
            >
              <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
              <div className="mb-4">
                <span className="text-4xl font-bold">{plan.price}</span>
                {plan.period && <span className="text-sm">{plan.period}</span>}
              </div>
              <p className={`text-sm mb-6 ${plan.highlighted ? "text-blue-100" : "text-gray-600"}`}>
                {plan.description}
              </p>
              <div className={`text-sm font-semibold mb-6 ${plan.highlighted ? "text-blue-100" : "text-blue-600"}`}>
                {plan.credits}
              </div>
              <ul className="space-y-3 mb-8">
                {plan.features.map((feature, fidx) => (
                  <li key={fidx} className="flex items-start">
                    <span className="mr-3">✓</span>
                    <span className="text-sm">{feature}</span>
                  </li>
                ))}
              </ul>
              <button
                className={`w-full py-2 rounded font-semibold transition ${
                  plan.highlighted
                    ? "bg-white text-blue-600 hover:bg-gray-100"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                Get Started
              </button>
            </div>
          ))}
        </div>

        <div className="mt-12 p-6 bg-white border border-gray-200 rounded-lg">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Credit Costs by Model</h3>
          <div className="grid md:grid-cols-3 gap-8">
            <div>
              <div className="font-semibold text-gray-900">Claude Haiku 4.5</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">4 credits</div>
              <div className="text-sm text-gray-600">$0.40</div>
            </div>
            <div>
              <div className="font-semibold text-gray-900">Claude Sonnet 4.6</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">12 credits</div>
              <div className="text-sm text-gray-600">$1.20</div>
            </div>
            <div>
              <div className="font-semibold text-gray-900">Claude Opus 4.6</div>
              <div className="text-2xl font-bold text-blue-600 mt-1">20 credits</div>
              <div className="text-sm text-gray-600">$2.00</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
