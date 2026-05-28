#!/bin/bash
set -e
cd "$(dirname "$0")"
npx tsc --skipLibCheck 2>&1
echo "=== BUILD OK ==="
echo ""
for f in out/__tests__/model-registry.test.js out/__tests__/llm-client.test.js out/__tests__/providers.test.js out/__tests__/composite.test.js; do
    echo "--- $(basename $f) ---"
    node --test "$f" 2>&1 | grep -E "^# tests|^# pass|^# fail|^ok |^not ok" || true
    echo ""
done
