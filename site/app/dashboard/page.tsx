"use client";

import { useEffect, useState } from "react";
import DashboardContent from "@/components/DashboardContent";
import LoginPrompt from "@/components/LoginPrompt";

export default function DashboardPage() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    // Check for existing auth token
    const token = localStorage.getItem("github_token");
    if (token) {
      setIsAuthenticated(true);
      // In a real app, fetch user data with the token
    } else {
      setIsAuthenticated(false);
    }
  }, []);

  if (isAuthenticated === null) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return isAuthenticated ? (
    <DashboardContent user={user} />
  ) : (
    <LoginPrompt />
  );
}
