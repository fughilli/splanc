#!/bin/bash
# Regenerate the checked-in TypeScript protobuf bindings (web/src/gen/).
set -euo pipefail
cd "$(dirname "$0")/../../.."
pnpm --dir web exec buf generate --template "$(pwd)/buf.gen.yaml" || \
  ./web/node_modules/.bin/buf generate
echo "regenerated web/src/gen/"
