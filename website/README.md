# Agent Website

Product marketing and documentation site for the GitHub Agent service.

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Local Development

```bash
# Install dependencies
npm install

# Create .env.local with necessary variables
# NEXTAUTH_SECRET=<random-secret>
# GITHUB_ID=<from-github-app>
# GITHUB_SECRET=<from-github-app>

# Run development server
npm run dev
```

Visit `http://localhost:3000` to see the site.

## Deployment

### Vercel (Recommended)

1. Connect this repository to Vercel
2. Configure environment variables in Vercel dashboard:
   - `GITHUB_ID` - From GitHub App settings
   - `GITHUB_SECRET` - From GitHub App settings
   - `NEXTAUTH_SECRET` - Generate with: `openssl rand -base64 32`
   - `AWS_REGION` - Cloud region (default: us-east-1)
   - `ARTIFACTS_BUCKET` - S3 bucket for credits data
3. Deploy

### Custom Deployment

```bash
# Build
npm run build

# Start production server
npm run start
```

## Environment Variables

Required for production:
- `GITHUB_ID` - GitHub OAuth App Client ID
- `GITHUB_SECRET` - GitHub OAuth App Client Secret
- `NEXTAUTH_SECRET` - Session encryption secret (generate: `openssl rand -base64 32`)
- `NEXTAUTH_URL` - Full deployment URL (e.g., https://agent.cenetex.com)
- `AWS_REGION` - AWS region where credits bucket exists
- `ARTIFACTS_BUCKET` - S3 bucket containing credit data

## Project Structure

```
website/
├── app/
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Landing page
│   ├── pricing/            # Pricing page
│   ├── docs/               # Documentation pages
│   ├── dashboard/          # Authenticated dashboard
│   ├── api/                # API routes (auth, data)
│   └── globals.css         # Global styles
├── components/             # Reusable components
│   ├── navigation.tsx
│   ├── footer.tsx
│   ├── hero.tsx
│   ├── how-it-works.tsx
│   └── pricing.tsx
├── lib/                    # Utilities
├── public/                 # Static assets
├── next.config.js
├── tailwind.config.js
└── tsconfig.json
```

## Pages

### Public Pages
- `/` - Landing page with hero, how-it-works, pricing
- `/docs` - Documentation hub
- `/docs/getting-started` - Installation and first steps
- `/docs/credit-system` - Credit model and costs
- `/docs/task-lifecycle` - Task states and workflow
- `/docs/configuring-agent` - AGENT.md and CLAUDE.md setup
- `/docs/review-process` - Code review capabilities
- `/docs/troubleshooting` - Common issues and solutions
- `/pricing` - Pricing details

### Authenticated Pages
- `/signin` - GitHub OAuth sign-in
- `/dashboard` - Overview and balance
- `/dashboard/tasks` - Task history
- `/dashboard/spending` - Spending trends (stub)
- `/dashboard/credits` - Credit purchase (stub)

## Technology Stack

- **Framework**: Next.js 14+
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Authentication**: NextAuth.js (GitHub OAuth)
- **AWS SDK**: boto3 for S3 operations
- **Icons**: react-icons

## Development

### Add New Documentation Page

1. Create new file in `app/docs/[page].tsx`
2. Add navigation link in `app/docs/page.tsx`
3. Use the prose classes from Tailwind Typography plugin

### Add New Dashboard Section

1. Create new file in `app/dashboard/[section]/page.tsx`
2. Add navigation link in `app/dashboard/layout.tsx`
3. Implement data-fetching as needed from S3/API

### Styling

Uses Tailwind CSS. Update styles in:
- `app/globals.css` - Global styles
- `tailwind.config.js` - Tailwind configuration

## Building for Production

```bash
npm run build
npm run start
```

The site is ready for deployment!

## License

MIT
