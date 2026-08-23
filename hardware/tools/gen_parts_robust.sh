#!/usr/bin/env bash
# Robust generator: retries each part in-loop to ride out EasyEDA's flaky
# CloudFront throttling, and skips parts already generated. Same args as
# gen_parts.sh: <project-dir> <lcsc-id>...
set -u
PROJ="${1:?usage: gen_parts_robust.sh <project-dir> <lcsc-id>...}"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
cp "${HERE}/picker_server.py" "${WORK}/server.py"
cp "${HERE}/picker_catalog.json" "${WORK}/catalog.json"
python3 "${WORK}/server.py" 8099 >/tmp/apick.log 2>&1 &
P=$!
sleep 2
cd "${PROJ}" || exit 1
for id in "$@"; do
  if grep -Rqs "easyeda:C${id}\"" elec/src/parts/ 2>/dev/null; then
    echo "SKIP C${id} (present)"
    continue
  fi
  ok=0
  for attempt in $(seq 1 "${GEN_TRIES:-10}"); do
    out=$(ATO_NON_INTERACTIVE=1 ato create part -s "C${id}" -a 2>&1)
    name=$(echo "${out}" | grep -oE "Created [A-Za-z0-9_]+" | head -1 | sed "s/Created //")
    if [ -n "${name}" ]; then
      echo "OK C${id} -> ${name} (try ${attempt})"
      ok=1
      break
    fi
    sleep "${GEN_RETRY_DELAY:-8}"
  done
  [ "${ok}" = 0 ] && echo "FAIL C${id}"
  sleep 3
done
kill "${P}" 2>/dev/null
rm -rf "${WORK}"
echo "ROBUST-DONE"
