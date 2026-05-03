'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface RepoBalance {
  repo_slug: string;
  current_balance: number;
  total_purchased: number;
  total_spent: number;
  last_updated: string;
}

function getBalanceColor(balance: number): string {
  if (balance < 50) return 'text-red-600';
  if (balance < 200) return 'text-yellow-600';
  return 'text-green-600';
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg shadow p-6 animate-pulse">
      <div className="h-4 bg-gray-200 rounded w-24 mb-4"></div>
      <div className="h-10 bg-gray-200 rounded w-20 mb-2"></div>
      <div className="h-3 bg-gray-200 rounded w-32"></div>
    </div>
  );
}

export default function DashboardOverview() {
  const [balances, setBalances] = useState<RepoBalance[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchBalances = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/api/dashboard/balance');

        if (res.status === 401) {
          setError('Please sign in to view your credit balances');
          setBalances([]);
          return;
        }

        if (!res.ok) {
          throw new Error(`Failed to fetch balances: ${res.status}`);
        }

        const data: RepoBalance[] = await res.json();
        setBalances(data);
      } catch (err) {
        console.error('Error fetching balances:', err);
        setError(err instanceof Error ? err.message : 'Failed to load credit data');
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, []);

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <p className="text-red-800">{error}</p>
        </div>
      </div>
    );
  }

  if (!balances || balances.length === 0) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold mb-8">Dashboard Overview</h1>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">No Installations Yet</h2>
          <p className="text-gray-700 mb-4">
            Install the cenetex-coding-agent GitHub App to manage credits for your repositories.
          </p>
          <a
            href="https://github.com/apps/cenetex-coding-agent/installations/new"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Install GitHub App
          </a>
        </div>
      </div>
    );
  }

  const totalBalance = balances.reduce((sum, b) => sum + b.current_balance, 0);
  const totalPurchased = balances.reduce((sum, b) => sum + b.total_purchased, 0);
  const totalSpent = balances.reduce((sum, b) => sum + b.total_spent, 0);

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-2">Dashboard Overview</h1>
      <p className="text-gray-600 mb-8">{totalBalance} credits across {balances.length} repo{balances.length !== 1 ? 's' : ''}</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Balance</h2>
          <p className="text-4xl font-bold text-blue-600">{totalBalance}</p>
          <p className="text-gray-500 text-sm mt-1">credits available</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Spent</h2>
          <p className="text-4xl font-bold text-orange-600">{totalSpent}</p>
          <p className="text-gray-500 text-sm mt-1">credits used</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-gray-600 text-sm font-semibold mb-2">Total Purchased</h2>
          <p className="text-4xl font-bold text-green-600">{totalPurchased}</p>
          <p className="text-gray-500 text-sm mt-1">credits purchased</p>
        </div>
      </div>

      <div>
        <h2 className="text-2xl font-bold mb-4">Your Repositories</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {balances.map((balance) => (
            <div key={balance.repo_slug} className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">{balance.repo_slug}</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-gray-600">Current Balance</span>
                  <span className={`text-2xl font-bold ${getBalanceColor(balance.current_balance)}`}>
                    {balance.current_balance}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-600">Purchased</span>
                  <span className="text-gray-900">{balance.total_purchased}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-gray-600">Spent</span>
                  <span className="text-gray-900">{balance.total_spent}</span>
                </div>
                <div className="text-xs text-gray-500 pt-2">
                  Updated: {new Date(balance.last_updated).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
