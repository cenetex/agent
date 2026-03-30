export default function CTA() {
  return (
    <section className="bg-blue-600 text-white py-16 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto text-center">
        <h2 className="text-4xl font-bold mb-6">Ready to automate your workflow?</h2>
        <p className="text-xl text-blue-100 mb-8">
          Install the Agent GitHub App on your repositories and start automating today.
          First 100 credits are free.
        </p>
        <div className="flex gap-4 justify-center flex-wrap">
          <a
            href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&scope=repo"
            className="px-8 py-3 bg-white text-blue-600 font-semibold rounded-lg hover:bg-blue-50 transition"
          >
            Install Now
          </a>
          <a
            href="/docs"
            className="px-8 py-3 border-2 border-white text-white font-semibold rounded-lg hover:bg-blue-700 transition"
          >
            View Documentation
          </a>
        </div>
      </div>
    </section>
  );
}
