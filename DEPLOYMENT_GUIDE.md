# Agent Website Deployment Guide

This guide covers deploying agent.cenetex.com to Vercel.

## Prerequisites

- Vercel account connected to GitHub
- GitHub OAuth App created with redirect URLs configured
- AWS account with S3 bucket for credits data
- Domain agent.cenetex.com (managed via Route53 or Cloudflare)

## Step 1: Create GitHub OAuth App

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: Agent Dashboard
   - **Homepage URL**: https://agent.cenetex.com
   - **Authorization callback URL**: https://agent.cenetex.com/api/auth/callback/github
4. Copy your **Client ID** and generate a **Client Secret**
5. Save these for Step 3

## Step 2: Set Up Vercel Project

1. Go to https://vercel.com/dashboard
2. Click "Add New..." → "Project"
3. Select the `agent` repository
4. Configure project:
   - **Framework Preset**: Next.js
   - **Root Directory**: `website`
   - **Build Command**: `npm run build`
   - **Output Directory**: `.next`

## Step 3: Configure Environment Variables

In Vercel dashboard, go to Settings → Environment Variables and add:

```
GITHUB_ID: <from GitHub OAuth App>
GITHUB_SECRET: <from GitHub OAuth App>
NEXTAUTH_SECRET: <generate with: openssl rand -base64 32>
NEXTAUTH_URL: https://agent.cenetex.com
AWS_REGION: us-east-1
ARTIFACTS_BUCKET: github-agent-artifacts-<account-id>-us-east-1
```

Optional for AWS credentials:
```
AWS_ACCESS_KEY_ID: <if using static credentials>
AWS_SECRET_ACCESS_KEY: <if using static credentials>
```

Otherwise, configure AWS IAM for Vercel using OIDC (recommended).

## Step 4: Configure Custom Domain

1. In Vercel project settings, go to Domains
2. Add custom domain: `agent.cenetex.com`
3. Vercel will provide DNS records to add
4. In Route53 or Cloudflare, add the DNS records provided by Vercel
5. Wait for DNS propagation (usually 5-10 minutes)

## Step 5: Deploy

Option A: **Automatic Deployment**
- Push changes to `main` branch
- Vercel automatically builds and deploys

Option B: **Manual Deployment**
- In Vercel dashboard, click "Redeploy" on the latest build

## Step 6: Verify Deployment

1. Visit https://agent.cenetex.com
2. Check that landing page loads
3. Navigate to /docs and verify pages render
4. Try GitHub OAuth sign-in
5. Verify dashboard loads (may show mock data if S3 not configured)
6. Check CloudWatch logs for any S3 access errors

## Configuration: GitHub App Integration

The website uses GitHub OAuth for authentication. Users sign in with their GitHub account to access:
- Credit dashboard (read-only S3 data)
- Task history (from S3 artifacts)
- Spending analytics (derived from transactions)

## Configuration: AWS S3 Access

The website needs read-only access to S3 bucket at:
```
s3://github-agent-artifacts-<account-id>-us-east-1/credits/*/balance.json
s3://github-agent-artifacts-<account-id>-us-east-1/credits/*/ledger/*
```

### Option 1: IAM Role via OIDC (Recommended)

1. Set up OIDC trust relationship in AWS IAM
2. Create role with S3 read permissions to `credits/` path
3. No credentials needed in environment variables

### Option 2: Static AWS Credentials

1. Create IAM user in AWS
2. Generate access key and secret key
3. Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in Vercel

### Example IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::github-agent-artifacts-*/credits/*/balance.json",
        "arn:aws:s3:::github-agent-artifacts-*/credits/*/ledger/*"
      ]
    }
  ]
}
```

## Monitoring

### Vercel Logs
- Dashboard URL: https://vercel.com/dashboard
- Click on project → Deployments → Select deployment → Logs

### Application Monitoring
- Visit /api/health (future: implement health check endpoint)
- Monitor GitHub OAuth errors in Vercel logs
- Monitor S3 access errors in Vercel logs

## Troubleshooting

### GitHub OAuth Not Working
- Verify GitHub OAuth App callback URL matches production domain
- Check GITHUB_ID and GITHUB_SECRET are correct
- Check NEXTAUTH_SECRET is set and non-empty

### Dashboard Showing Errors
- Verify AWS credentials have S3 read permissions
- Check S3 bucket name is correct
- Verify credit data files exist in S3

### Slow Dashboard Load
- Check S3 latency
- Implement caching layer (coming soon)
- Consider using CloudFront for S3 (coming soon)

## Rollback

To rollback to a previous deployment:
1. In Vercel dashboard, go to Deployments
2. Find the previous working deployment
3. Click the three-dot menu → "Promote to Production"

## Next Steps

1. Monitor analytics and user feedback
2. Improve dashboard UI based on feedback
3. Implement credit purchase system
4. Add email notifications
5. Open source the codebase on GitHub
