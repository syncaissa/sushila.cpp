#!/usr/bin/env bash
# Create the DynamoDB tables the sushila.ai worker uses (all named sushilaai-*), on-demand billing, with TTL on sign-in codes.
# Run once with an AWS account that may create tables:   AWS_REGION=ap-south-1 bash aws_tables.sh
# Then give the worker's AWS key only the permissions in iam_policy.json (these tables, item-level actions only).
set -euo pipefail
R=${AWS_REGION:?set AWS_REGION to the region in the worker settings}
mk() {  # mk <table> <hash key> [<range key>]
  if aws dynamodb describe-table --region "$R" --table-name "$1" > /dev/null 2>&1; then echo "$1 exists"; return; fi
  local attrs="AttributeName=$2,AttributeType=S" keys="AttributeName=$2,KeyType=HASH"
  if [ -n "${3:-}" ]; then attrs="$attrs AttributeName=$3,AttributeType=S"; keys="$keys AttributeName=$3,KeyType=RANGE"; fi
  aws dynamodb create-table --region "$R" --table-name "$1" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions $attrs --key-schema $keys --tags Key=project,Value=sushila.ai > /dev/null
  aws dynamodb wait table-exists --region "$R" --table-name "$1"
  echo "$1 created"
}
mk sushilaai-users email                 # account: primary e-mail, e-mails (set), name, organization, created/last sign-in
mk sushilaai-emails email                # every verified e-mail -> primaryEmail of its account
mk sushilaai-otps email                  # pending sign-in code (keyed hash), expiry, attempts; removed by TTL
mk sushilaai-downloads userEmail downloadedAt   # one row per download: model, file, B2 key, sha256, license accepted, country
mk sushilaai-waitlist email              # serverless-API early access
mk sushilaai-audit day at                # sign-ups, sign-ins, e-mail changes, downloads
aws dynamodb update-time-to-live --region "$R" --table-name sushilaai-otps \
  --time-to-live-specification Enabled=true,AttributeName=ttl > /dev/null 2>&1 || true
aws dynamodb update-continuous-backups --region "$R" --table-name sushilaai-users \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true > /dev/null 2>&1 || true
echo done
