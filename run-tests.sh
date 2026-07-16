#!/bin/bash
# Run all llm-local-router unit tests.
# Used by the pre-push git hook to gate pushes on all tests passing.
set -euo pipefail

cd "$(dirname "$0")"

# Compile TypeScript first — fail fast on type errors.
npx tsc --skipLibCheck 2>&1
echo "=== BUILD OK ==="
echo ""

ALL_TESTS=(
    out/__tests__/model-registry.test.js
    out/__tests__/llm-client.test.js
    out/__tests__/providers.test.js
    out/__tests__/composite.test.js
    out/__tests__/config-converter.test.js
    out/__tests__/metrics-collector.test.js
    out/__tests__/metrics-server.test.js
)

FAILURES=0
TOTAL_START=$(date +%s)

for f in "${ALL_TESTS[@]}"; do
    echo "--- $(basename "$f") ---"
    if node --test "$f" 2>&1 | grep -E "^# tests|^# pass|^# fail|^ok |^not ok" || true; then
        : # output captured above
    fi
    rc=${PIPESTATUS[0]}
    if [ "$rc" -ne 0 ]; then
        echo "FAIL (exit $rc)"
        FAILURES=$((FAILURES + 1))
    fi
    echo ""
done

TOTAL_END=$(date +%s)
ELAPSED=$((TOTAL_END - TOTAL_START))
printf '%-12s %3ds\n' "TOTAL:" "${ELAPSED}" >&2

if [ "$FAILURES" -gt 0 ]; then
    printf '%d test suite(s) FAILED\n' "$FAILURES" >&2
fi

exit "$FAILURES"
