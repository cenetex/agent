export default function Hero() {
  return (
    <section className="bg-gradient-to-br from-blue-50 to-indigo-100 py-20 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto text-center">
        <h1 className="text-5xl md:text-6xl font-bold text-gray-900 mb-6">
          Autonomous Coding Agent for GitHub
        </h1>
        <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
          Automatically fix bugs, implement features, and review pull requests using AI.
          Install on your GitHub repositories and label issues to get started.
        </p>
        <div className="flex gap-4 justify-center flex-wrap">
          <a
            href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&scope=repo"
            className="px-8 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
          >
            Install GitHub App
          </a>
          <a
            href="/docs"
            className="px-8 py-3 bg-white text-blue-600 font-semibold border-2 border-blue-600 rounded-lg hover:bg-blue-50 transition"
          >
            Read Docs
          </a>
        </div>
      </div>
    </section>
  );
}
