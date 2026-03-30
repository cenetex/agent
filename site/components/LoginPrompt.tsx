export default function LoginPrompt() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">Dashboard</h1>
        <p className="text-xl text-gray-600 mb-8 max-w-md">
          Sign in with GitHub to view your credits and task history
        </p>
        <a
          href="https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&scope=repo"
          className="inline-block px-8 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
        >
          Sign In with GitHub
        </a>
      </div>
    </div>
  );
}
