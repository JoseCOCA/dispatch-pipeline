#!/usr/bin/env bash
#
# Creates a monthly AWS Budget that emails you at 50%, 80% and 100% of a spend cap.
#
# Run this BEFORE the first `cdk deploy`. A budget alarm is the only thing standing
# between a misconfigured loop and a surprise invoice — a $1 project and a $900
# project look identical until the bill arrives.
#
# Usage: ./scripts/create-budget-alarm.sh you@example.com [limit-usd]

set -euo pipefail

EMAIL="${1:-}"
LIMIT="${2:-5}"

if [[ -z "$EMAIL" ]]; then
  echo "usage: $0 <email> [limit-usd, default 5]" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUDGET_NAME="dispatch-pipeline-guardrail"

echo "Account:  $ACCOUNT_ID"
echo "Budget:   $BUDGET_NAME"
echo "Limit:    \$$LIMIT USD / month"
echo "Notify:   $EMAIL"
echo

if aws budgets describe-budget \
  --account-id "$ACCOUNT_ID" \
  --budget-name "$BUDGET_NAME" \
  >/dev/null 2>&1; then
  echo "Budget '$BUDGET_NAME' already exists — nothing to do."
  exit 0
fi

NOTIFICATIONS="$(
  for THRESHOLD in 50 80 100; do
    cat <<JSON
{
  "Notification": {
    "NotificationType": "ACTUAL",
    "ComparisonOperator": "GREATER_THAN",
    "Threshold": $THRESHOLD,
    "ThresholdType": "PERCENTAGE"
  },
  "Subscribers": [
    { "SubscriptionType": "EMAIL", "Address": "$EMAIL" }
  ]
}
JSON
  done | jq -s '.'
)"

aws budgets create-budget \
  --account-id "$ACCOUNT_ID" \
  --budget "{
    \"BudgetName\": \"$BUDGET_NAME\",
    \"BudgetLimit\": { \"Amount\": \"$LIMIT\", \"Unit\": \"USD\" },
    \"TimeUnit\": \"MONTHLY\",
    \"BudgetType\": \"COST\"
  }" \
  --notifications-with-subscribers "$NOTIFICATIONS"

echo
echo "Budget created. Confirm the subscription in your inbox if prompted."
