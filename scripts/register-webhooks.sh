#!/bin/bash
set -euo pipefail

# Register GitHub webhooks on multiple repositories
# Usage: ./register-webhooks.sh

ORG="cenetex"
REPOS=("aws-swarm" "kyro" "ratibot")

# Get webhook URL from CloudFormation stack
WEBHOOK_URL=$(aws cloudformation describe-stacks --stack-name GitHubAgentStack \
  --query 'Stacks[0].Outputs[?OutputKey==`WebhookUrl`].OutputValue' --output text)

if [ -z "$WEBHOOK_URL" ]; then
  echo "❌ Failed to get webhook URL from CloudFormation stack"
  exit 1
fi

echo "🔗 Webhook URL: $WEBHOOK_URL"

# Get webhook secret from AWS SSM
WEBHOOK_SECRET=$(aws ssm get-parameter --name /github-agent/GITHUB_WEBHOOK_SECRET \
  --with-decryption --query Parameter.Value --output text)

if [ -z "$WEBHOOK_SECRET" ]; then
  echo "❌ Failed to get webhook secret from SSM"
  exit 1
fi

echo "🔐 Webhook secret retrieved"

# Register webhook on each repo
for REPO in "${REPOS[@]}"; do
  echo ""
  echo "📝 Registering webhook for $ORG/$REPO..."

  RESPONSE=$(gh api repos/$ORG/$REPO/hooks --method POST \
    -f "config[url]=${WEBHOOK_URL}" \
    -f "config[content_type]=json" \
    -f "config[secret]=${WEBHOOK_SECRET}" \
    -f "events[]=issues" \
    -f "events[]=pull_request" \
    2>&1 || echo "ERROR")

  if echo "$RESPONSE" | grep -q "ERROR"; then
    echo "❌ Failed to register webhook for $REPO: $RESPONSE"
  else
    HOOK_ID=$(echo "$RESPONSE" | jq -r '.id' 2>/dev/null || echo "unknown")
    echo "✅ Webhook registered for $REPO (ID: $HOOK_ID)"
  fi
done

echo ""
echo "✨ Webhook registration complete!"
