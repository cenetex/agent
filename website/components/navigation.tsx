'use client'

import Link from 'next/link'
import { FiGithub, FiMenu, FiX } from 'react-icons/fi'
import { useState } from 'react'

export function Navigation() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <nav className="border-b border-gray-200 bg-white sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center space-x-2 font-bold text-lg">
            <span className="text-blue-600">⚡</span>
            <span>Agent</span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-8">
            <Link href="/docs" className="text-gray-600 hover:text-gray-900">
              Docs
            </Link>
            <Link href="/pricing" className="text-gray-600 hover:text-gray-900">
              Pricing
            </Link>
            <a
              href="https://github.com/cenetex/agent"
              className="text-gray-600 hover:text-gray-900"
              target="_blank"
              rel="noopener noreferrer"
            >
              <FiGithub className="w-5 h-5" />
            </a>
            <a
              href="https://github.com/apps/cenetex-coding-agent/installations/new"
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
              Install
            </a>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden"
            onClick={() => setIsOpen(!isOpen)}
          >
            {isOpen ? <FiX className="w-6 h-6" /> : <FiMenu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Navigation */}
        {isOpen && (
          <div className="md:hidden pb-4 space-y-3">
            <Link href="/docs" className="block text-gray-600 hover:text-gray-900">
              Docs
            </Link>
            <Link href="/pricing" className="block text-gray-600 hover:text-gray-900">
              Pricing
            </Link>
            <a
              href="https://github.com/cenetex/agent"
              className="block text-gray-600 hover:text-gray-900"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              href="https://github.com/apps/cenetex-coding-agent/installations/new"
              className="block bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-center"
            >
              Install App
            </a>
          </div>
        )}
      </div>
    </nav>
  )
}
