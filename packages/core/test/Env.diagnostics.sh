#!/usr/bin/env bash
set -euo pipefail
core_dir="$(cd "$(dirname "$0")/.." && pwd)"
probe_dir="$(mktemp -d "$core_dir/test/.env-diagnostics.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT
cat > "$probe_dir/probe.ts" <<'TS'
import * as Env from "../../src/Env.js";
import * as Component from "../../src/Component.js";
import * as Schema from "effect/Schema";

Env.make("host", {
  CONVEX_SITE_URL: Env.string(),
  CONVEX_CLOUD_URL: Env.string(),
});
Component.make("evil", {
  env: {
    CONVEX_SITE_URL: Schema.String,
    CONVEX_CLOUD_URL: Schema.String,
  },
  client: (native: unknown) => native,
});
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
  test "$(printf '%s\n' "$output" | rg -c 'error TS')" -eq 4
  for line in 6 7 11 12; do
    printf '%s\n' "$output" | rg "probe.ts\($line,.*error TS.*reservedForConvexBuiltIn" >/dev/null
  done
  printf 'PASS exactOptionalPropertyTypes=%s, one named diagnostic per property\n' "$exact"
done
