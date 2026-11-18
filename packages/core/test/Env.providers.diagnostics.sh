#!/usr/bin/env bash
set -euo pipefail
core_dir="$(cd "$(dirname "$0")/.." && pwd)"
probe_dir="$(mktemp -d "$core_dir/test/provider-probes.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT
for expression in 'Env.providers({ inner: {} })' 'Env.optional(Env.providers({ inner: {} }))'; do
  cat > "$probe_dir/probe.ts" <<TS
import * as Env from "../../src/Env.js";
Env.providers({ outer: { NESTED: $expression } });
TS
  for exact in true false; do
    cat > "$probe_dir/tsconfig.json" <<JSON
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "exactOptionalPropertyTypes": $exact },
  "include": ["probe.ts"]
}
JSON
    status=0
    output="$(cd "$core_dir" && pnpm exec tsrs --project "$probe_dir/tsconfig.json" --pretty false 2>&1)" || status=$?
    printf '%s\n' "$output"
    test "$status" -ne 0
    test "$(printf '%s\n' "$output" | rg -c 'error TS')" -eq 1
    printf '%s\n' "$output" | rg 'probe.ts\(2,.*error TS2322.*never' >/dev/null
    printf 'PASS %s, exactOptionalPropertyTypes=%s, exactly one diagnostic\n' "$expression" "$exact"
  done
done
