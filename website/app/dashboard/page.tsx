"use client";

import { useEffect, useState } from "react";

interface BalanceResponse {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
}

function getBalanceColor(balance: number): string {
  if (balance < 50) return "text-red-600";
  if (balance < 200) return "text-yellow-600";
  return "text-green-600";
}

function getBalanceBgColor(balance: number): string {
  if (balance < 50) return "bg-red-50";
  if (balance < 200) return "bg-yellow-50";
  return "bg-green-50";
}

export default function DashboardOverview() {
  const [data, setData] = useState<BalanceResponse[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;

    if (!token) {
      setError("Not authenticated. Please sign in.");
      setLoading(false);
      return;
    }

    const fetchBalances = async () => {
      try {
        const response = await fetch("/api/dashboard/balance", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.status === 401) {
          setError("Session expired. Please sign in again.");
          setLoading(false);
          return;
        }

        if (!response.ok) {
          throw new Error(`Failed to fetch balances: ${response.statusText}`);
        }

        const balances = await response.json();
        setData(balances);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load balance data");
        setData([]);
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, []);

  const totalBalance = data?.reduce((sum, b) => sum + b.current_balance, 0) ?? 0;
  const repoCount = data?.length ?? 0;

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="space-y-4">
          <div className="h-32 bg-gray-200 rounded-lg animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="h-40 bg-gray-200 rounded-lg animate-pulse" />
            <div className="h-40 bg-gray-200 rounded-lg animate-pulse" />
            <div className="h-40 bg-gray-200 rounded-lg animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-red-900 mb-2">Error</h2>
          <p className="text-red-700">{error}</p>
          {error.includes("Not authenticated") && (
            <a href="/signin" className="inline-block mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Sign In
            </a>
          )}
        </div>
      </div>
    );
  }

  if (data && data.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-900 mb-2">No GitHub App Installations</h2>
          <p className="text-blue-700 mb-4">
            You haven't installed the cenetex-coding-agent GitHub App yet. Install it to start using the agent and view your credit balance.
          </p>
          <a
            href="https://github.com/apps/cenetex-coding-agent/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Install GitHub App
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>

      {data && data.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-semibold text-blue-900">Total Summary</h2>
          <p className="text-blue-700 mt-2">
            <span className="text-3xl font-bold text-blue-600">{totalBalance}</span> credits across{" "}
            <span className="font-semibold">{repoCount}</span> repo{repoCount !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {data?.map((balance) => (
          <div
            key={balance.repo_slug}
            className={`${getBalanceBgColor(balance.current_balance)} rounded-lg shadow p-6 border-l-4`}
          >
            <h2 className="text-gray-600 text-sm font-semibold mb-1">{balance.repo_slug}</h2>
            <p className={`text-4xl font-bold mb-1 ${getBalanceColor(balance.current_balance)}`}>
              {balance.current_balance}
            </p>
            <p className="text-gray-500 text-sm mb-4">credits available</p>

            <div className="space-y-2 text-sm text-gray-600">
              <p>
                <span className="font-semibold">Purchased:</span> {balance.total_purchased}
              </p>
              <p>
                <span className="font-semibold">Spent:</span> {balance.total_spent}
              </p>
              <p className="text-xs text-gray-500">
                Updated: {new Date(balance.last_updated).toLocaleDateString()}
              </p>
            </div>
          </div>
        ))}
      </div>

      {data && data.length === 0 && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <p className="text-gray-600">
            No credit balance data available. Make sure you have at least one repository with the GitHub App installed.
          </p>
        </div>
      )}
    </div>
  );
}
