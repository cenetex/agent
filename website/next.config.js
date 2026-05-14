/** @type {import('next').NextConfig} */
const path = require('path')

const nextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  trailingSlash: true,
}

module.exports = nextConfig
