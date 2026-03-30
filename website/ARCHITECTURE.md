# Agent Website Architecture

## Overview

The Agent website is a Next.js 14 application serving as the product marketing and documentation hub for the GitHub coding agent service. It includes a landing page, comprehensive documentation, and an authenticated dashboard for managing credits.

## Project Structure

```
website/
├── app/                          # Next.js App Router
│   ├── layout.tsx               # Root layout with navigation/footer
│   ├── page.tsx                 # Landing page
│   ├── globals.css              # Global Tailwind styles
│   │
│   ├── pricing/
│   │   └── page.tsx            # Public pricing page
│   │
│   ├── docs/                    # Documentation pages (public)
│   │   ├── page.tsx            # Docs hub with category cards
│   │   ├── getting-started.tsx  # Installation guide
│   │   ├── credit-system.tsx    # Credit model explanation
│   │   ├── task-lifecycle.tsx   # Task states and workflows
│   │   ├── configuring-agent.tsx # AGENT.md and CLAUDE.md reference
│   │   ├── review-process.tsx   # Auto-review guide
│   │   └── troubleshooting.tsx  # Common issues and solutions
│   │
│   ├── signin/                  # GitHub OAuth sign-in page
│   │   └── page.tsx
│   │
│   ├── dashboard/               # Authenticated dashboard (requires login)
│   │   ├── layout.tsx          # Dashboard sidebar + layout
│   │   ├── page.tsx            # Overview dashboard
│   │   └── tasks/
│   │       └── page.tsx        # Task history view
│   │
│   └── api/                     # API routes
│       ├── auth/
│       │   └── [...nextauth].ts # NextAuth.js handler
│       └── dashboard/
│           └── balance.ts      # Fetch credit balance from S3
│
├── components/                  # Reusable React components
│   ├── navigation.tsx           # Top navigation bar
│   ├── footer.tsx              # Footer with links
│   ├── hero.tsx                # Landing page hero section
│   ├── how-it-works.tsx        # 6-step workflow visualization
│   └── pricing.tsx             # Pricing table and FAQ
│
├── package.json                 # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── tailwind.config.js          # Tailwind CSS configuration
├── postcss.config.js           # PostCSS configuration
├── next.config.js              # Next.js configuration
├── vercel.json                 # Vercel deployment config
├── .env.example                # Environment variable template
├── .gitignore                  # Git ignore rules
├── README.md                   # Project README
└── ARCHITECTURE.md             # This file
```

## Key Components

### Landing Page (page.tsx)
- **Hero Section**: Headline, subheading, CTA buttons
- **How It Works**: 6-step workflow cards
- **Pricing**: Model costs and tier comparison

### Documentation
- **Hub (docs/page.tsx)**: Navigation cards linking to all docs
- **Content Pages**: Prose-formatted guides with examples
- **Styling**: Tailwind Typography classes for readable content

### Dashboard
- **Authentication**: NextAuth.js with GitHub OAuth
- **Layout (dashboard/layout.tsx)**: Sidebar navigation
- **Pages**:
  - Overview: Balance, spending, stats
  - Task History: List of completed tasks with metadata
  - Spending Analytics: Trends (stub)
  - Credits: Purchase flow (stub)

### Components

**Navigation.tsx**
- Top navigation bar with logo, links, install button
- Mobile-responsive hamburger menu
- Links to docs, pricing, GitHub

**Footer.tsx**
- Footer with product links
- Social media links (GitHub, Twitter)
- Legal links (privacy, terms)

**Hero.tsx**
- Large headline and subheading
- Two CTA buttons (Install, Learn More)
- Three feature cards with icons

**HowItWorks.tsx**
- 6-step process visualization
- Each step with icon, title, description
- Example workflow at bottom

**Pricing.tsx**
- Three pricing tiers (Free, Pro, Enterprise)
- Model pricing table
- FAQ section

## Authentication Flow

1. **Sign-In Page** (`/signin`)
   - User clicks "Sign in with GitHub"
   - Redirects to GitHub OAuth endpoint

2. **GitHub OAuth** (NextAuth.js)
   - GitHub redirects back to `/api/auth/callback/github`
   - Session created and stored

3. **Dashboard** (`/dashboard`)
   - Protected route checks for session
   - If no session, redirects to `/signin`
   - If session exists, renders dashboard

4. **Sign-Out**
   - Clears session and redirects to home

## Data Flow

### Static Pages
- Public pages (landing, docs) are statically generated
- Deployed as static HTML files

### Dashboard (Dynamic)
1. User navigates to `/dashboard`
2. `useSession()` hook checks for authentication
3. If authenticated, component fetches data:
   - GitHub: Get user repos (future)
   - S3: `credentials/{owner}/{repo}/balance.json`
   - S3: `credentials/{owner}/{repo}/ledger/{YYYY}/{MM}/transactions.jsonl`
4. Data displayed in dashboard tables/cards

### API Routes
```
/api/auth/[...nextauth]  → NextAuth.js handler (sign-in, sign-out, session)
/api/dashboard/balance   → Fetch credit balance from S3
/api/dashboard/repos     → List authenticated user's repos (future)
```

## Styling

### Tailwind CSS
- **Configuration**: `tailwind.config.js`
- **Global Styles**: `app/globals.css`
- **Components**: Inline Tailwind classes in JSX

### Design System
- **Colors**: Blue accent (blue-600), gray neutrals, status colors (green/red/yellow)
- **Spacing**: Consistent padding/margin scale
- **Typography**: System fonts, semantic heading hierarchy
- **Responsive**: Mobile-first, breakpoints at sm/md/lg

## Environment Variables

### Required (Production)
```
NEXTAUTH_URL          # Full deployment URL
NEXTAUTH_SECRET       # Session encryption key (32 bytes)
GITHUB_ID             # GitHub OAuth Client ID
GITHUB_SECRET         # GitHub OAuth Client Secret
AWS_REGION            # AWS region for S3
ARTIFACTS_BUCKET      # S3 bucket name
```

### Optional
```
AWS_ACCESS_KEY_ID     # If not using IAM role
AWS_SECRET_ACCESS_KEY # If not using IAM role
```

## Deployment

### Vercel
- **Build Command**: `npm run build`
- **Output Directory**: `.next`
- **Root Directory**: `website`
- **Environment Variables**: Set in Vercel dashboard
- **Custom Domain**: `agent.cenetex.com` via Route53

### Local Development
```bash
npm install
npm run dev
# Visit http://localhost:3000
```

## Performance Optimizations

### Current
- Static generation for public pages
- Tailwind CSS for minimal CSS output
- Image optimization via Next.js Image component (future)

### Future
- API route caching and revalidation
- S3 data caching layer (Redis)
- CloudFront CDN for S3 assets
- Database for transaction history (PostgreSQL)
- Background job for data aggregation

## Security

### Authentication
- NextAuth.js handles OAuth flow securely
- No credentials stored in frontend
- Secure session cookies with httpOnly flag

### Data Access
- Dashboard only accessible with valid session
- S3 API calls server-side with IAM credentials
- No direct S3 URLs exposed to client

### Secrets Management
- Environment variables in Vercel
- GitHub secrets stored in Vercel environment
- AWS credentials via IAM role (recommended)

## Testing

### Unit Testing (Future)
- Jest for component tests
- React Testing Library for component behavior
- API route mocking with MSW

### Integration Testing (Future)
- E2E tests with Playwright
- Dashboard authentication flow
- S3 data fetching

## Monitoring

### Vercel
- Deployment logs
- Function analytics
- Error tracking

### Application (Future)
- Sentry for error reporting
- Analytics for user behavior
- CloudWatch for AWS operations

## Future Enhancements

1. **Credit Purchase System**
   - Stripe integration
   - Invoice generation
   - Subscription management

2. **Dashboard Features**
   - Real-time spending charts
   - API token management
   - Webhook configuration

3. **Documentation**
   - Video tutorials
   - Interactive examples
   - API reference

4. **Self-Hosted Option**
   - Docker Compose setup
   - Custom model support
   - Multi-tenant configuration

5. **Analytics**
   - Usage metrics
   - ROI calculations
   - Team insights

## Related Files

- `/work/repo/DEPLOYMENT_GUIDE.md` - Vercel deployment instructions
- `/work/repo/website/README.md` - Project README
- `/work/repo/website/.env.example` - Environment template
