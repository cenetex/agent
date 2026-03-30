# Agent Product Site

Product website for the Agent GitHub App - built with Next.js and Tailwind CSS.

## Features

- **Landing Page**: Hero section, features overview, pricing, and call-to-action
- **Documentation**: Comprehensive guides for installation, configuration, and credit system
- **Dashboard**: Authenticated user dashboard for credit management and task history (stub)

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Deployment

### Vercel

1. Push code to GitHub
2. Connect repository to Vercel
3. Configure environment variables:
   - `NEXT_PUBLIC_GITHUB_CLIENT_ID` - GitHub App client ID
   - `GITHUB_CLIENT_SECRET` - GitHub App client secret
4. Deploy

### Amplify

1. Connect GitHub repository to AWS Amplify
2. Configure build settings:
   - Build command: `npm run build`
   - Output directory: `.next`
3. Add environment variables
4. Deploy

## Structure

```
site/
├── app/              # Next.js app directory
│   ├── page.tsx      # Landing page
│   ├── docs/         # Documentation pages
│   ├── dashboard/    # Dashboard pages
│   ├── layout.tsx    # Root layout
│   └── globals.css   # Global styles
├── components/       # React components
│   ├── docs/         # Documentation components
│   └── dashboard/    # Dashboard components
└── public/          # Static assets
```

## Configuration

Create a `.env.local` file for local development:

```
NEXT_PUBLIC_GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
```

## Notes

The dashboard is currently a stub implementation. Full integration with S3 credit data will be added in future releases.
