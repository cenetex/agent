import Link from "next/link";

export default function DocsNav() {
  return (
    <aside className="w-64 bg-gray-50 border-r border-gray-200 p-6 min-h-screen sticky top-16">
      <nav className="space-y-4">
        <div>
          <h3 className="font-semibold text-gray-900 mb-2">Getting Started</h3>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#installation" className="text-blue-600 hover:text-blue-700">
                Installation
              </a>
            </li>
            <li>
              <a href="#first-task" className="text-blue-600 hover:text-blue-700">
                Your First Task
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 mb-2">Concepts</h3>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#task-lifecycle" className="text-blue-600 hover:text-blue-700">
                Task Lifecycle
              </a>
            </li>
            <li>
              <a href="#labels" className="text-blue-600 hover:text-blue-700">
                Labels & Status
              </a>
            </li>
            <li>
              <a href="#credits" className="text-blue-600 hover:text-blue-700">
                Credit System
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 mb-2">Configuration</h3>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#agent-md" className="text-blue-600 hover:text-blue-700">
                AGENT.md Configuration
              </a>
            </li>
            <li>
              <a href="#claude-md" className="text-blue-600 hover:text-blue-700">
                CLAUDE.md for Custom Behavior
              </a>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900 mb-2">Advanced</h3>
          <ul className="space-y-1 text-sm">
            <li>
              <a href="#review-process" className="text-blue-600 hover:text-blue-700">
                Review Process
              </a>
            </li>
            <li>
              <a href="#troubleshooting" className="text-blue-600 hover:text-blue-700">
                Troubleshooting
              </a>
            </li>
          </ul>
        </div>
      </nav>
    </aside>
  );
}
