"use client";

import { useState } from "react";

interface Repository {
  name: string;
  owner: string;
  balance: number;
  spent: number;
  purchased: number;
}

interface Task {
  id: string;
  repo: string;
  issue: number;
  status: "running" | "succeeded" | "failed" | "waiting";
  cost: number;
  createdAt: string;
}

export default function DashboardContent({ user }: { user: any }) {
  const [repositories] = useState<Repository[]>([
    {
      name: "example-repo",
      owner: "my-org",
      balance: 75,
      spent: 25,
      purchased: 100,
    },
  ]);

  const [tasks] = useState<Task[]>([
    {
      id: "task-001",
      repo: "example-repo",
      issue: 123,
      status: "succeeded",
      cost: 12,
      createdAt: "2024-03-30",
    },
  ]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "running":
        return <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-sm">Running</span>;
      case "succeeded":
        return <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-sm">Succeeded</span>;
      case "failed":
        return <span className="px-2 py-1 bg-red-100 text-red-800 rounded text-sm">Failed</span>;
      case "waiting":
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-800 rounded text-sm">Waiting</span>;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">Manage your credits and task history</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="text-gray-600 text-sm mb-2">Total Credits</div>
          <div className="text-4xl font-bold text-blue-600">275</div>
          <div className="text-xs text-gray-500 mt-2">Across all repositories</div>
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="text-gray-600 text-sm mb-2">Credits Spent</div>
          <div className="text-4xl font-bold text-gray-900">25</div>
          <div className="text-xs text-gray-500 mt-2">This month</div>
        </div>
        <div className="bg-white p-6 rounded-lg border border-gray-200">
          <div className="text-gray-600 text-sm mb-2">Tasks Completed</div>
          <div className="text-4xl font-bold text-green-600">8</div>
          <div className="text-xs text-gray-500 mt-2">This month</div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 mb-8">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900">Repositories</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Repository</th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">Balance</th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">Spent</th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">Purchased</th>
              </tr>
            </thead>
            <tbody>
              {repositories.map((repo, idx) => (
                <tr key={idx} className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="font-semibold text-gray-900">{repo.owner}/{repo.name}</div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="font-semibold text-blue-600">{repo.balance}</div>
                  </td>
                  <td className="px-6 py-4 text-right text-gray-600">{repo.spent}</td>
                  <td className="px-6 py-4 text-right text-gray-600">{repo.purchased}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900">Recent Tasks</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Repository</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Issue</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Status</th>
                <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">Cost</th>
                <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">Date</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task, idx) => (
                <tr key={idx} className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="px-6 py-4 text-gray-900">{task.repo}</td>
                  <td className="px-6 py-4">
                    <a
                      href={`#${task.issue}`}
                      className="text-blue-600 hover:text-blue-700 font-semibold"
                    >
                      #{task.issue}
                    </a>
                  </td>
                  <td className="px-6 py-4">{getStatusBadge(task.status)}</td>
                  <td className="px-6 py-4 text-right text-gray-900 font-semibold">
                    {task.cost} credits
                  </td>
                  <td className="px-6 py-4 text-gray-600 text-sm">{task.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
