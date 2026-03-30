import React from "react";
import DocsNav from "@/components/DocsNav";
import GettingStarted from "@/components/docs/GettingStarted";

export default function DocsPage() {
  return (
    <div className="flex">
      <DocsNav />
      <main className="flex-1 max-w-4xl mx-auto p-8">
        <h1 className="text-4xl font-bold mb-8">Documentation</h1>
        <GettingStarted />
      </main>
    </div>
  );
}
