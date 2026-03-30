# Deployment Guide

## Vercel Deployment

### Prerequisites
- GitHub repository with this code
- Vercel account
- Agent GitHub App credentials

### Steps

1. **Import project to Vercel:**
   - Go to https://vercel.com/new
   - Import this GitHub repository
   - Vercel will auto-detect Next.js configuration

2. **Configure environment variables in Vercel:**
   - Go to Settings → Environment Variables
   - Add the following:
     ```
     NEXT_PUBLIC_GITHUB_CLIENT_ID=your_github_app_client_id
     GITHUB_CLIENT_SECRET=your_github_app_client_secret
     ```

3. **Set up custom domain:**
   - Go to Settings → Domains
   - Add `agent.cenetex.com`
   - Follow DNS configuration steps

4. **Deploy:**
   - Push to main branch
   - Vercel will auto-deploy

## AWS Amplify Deployment

### Prerequisites
- AWS account
- GitHub repository connected to GitHub
- Agent GitHub App credentials

### Steps

1. **Create Amplify app:**
   ```bash
   amplify init
   amplify add hosting
   ```

2. **Configure build settings:**
   - Build command: `npm run build`
   - Start command: `npm start`
   - Base directory: `site`

3. **Add environment variables:**
   - NEXT_PUBLIC_GITHUB_CLIENT_ID
   - GITHUB_CLIENT_SECRET

4. **Connect custom domain:**
   ```bash
   amplify add domain
   ```

5. **Deploy:**
   ```bash
   amplify publish
   ```

## Environment Variables

### Required
- `NEXT_PUBLIC_GITHUB_CLIENT_ID` - Your GitHub App's Client ID
- `GITHUB_CLIENT_SECRET` - Your GitHub App's Client Secret

### Optional
- `API_BASE_URL` - Base URL for backend API (if separate backend exists)
- `S3_BUCKET` - S3 bucket for storing task metadata
- `AWS_REGION` - AWS region for S3 access

## Post-Deployment

1. **Test the installation flow:**
   - Click "Install App" button
   - Verify GitHub OAuth redirect works

2. **Monitor logs:**
   - Vercel: Dashboard → Deployments → Logs
   - Amplify: App → Monitoring

3. **Update GitHub App settings:**
   - Set Webhook URL if using backend API
   - Update callback URLs for OAuth

## Troubleshooting

### Build fails
- Check Node version in `.nvmrc` or `package.json` engines
- Ensure all dependencies are listed in `package.json`

### OAuth not working
- Verify GitHub App credentials are correct
- Check redirect URI matches GitHub App settings

### Styles not loading
- Clear browser cache
- Rebuild and redeploy
