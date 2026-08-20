#!/usr/bin/env bash
# Like gen_parts.sh but tolerant of EasyEDA's CloudFront rate-limit: it waits for
# the /components endpoint to recover before each fetch and spaces requests out,
# so a large batch doesn't re-trigger the block. Same args as gen_parts.sh.
set -u
PROJ="${1:?usage: gen_parts_patient.sh <project-dir> <lcsc-id>...}"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8099
WORK="$(mktemp -d)"
cp "${HERE}/picker_server.py" "${WORK}/server.py"
cp "${HERE}/picker_catalog.json" "${WORK}/catalog.json"
python3 "${WORK}/server.py" "${PORT}" >/tmp/apick.log 2>&1 &
P=$!
sleep 2
cd "${PROJ}" || exit 1

wait_easyeda() {
  # Block until the EasyEDA components endpoint serves JSON (not the CloudFront
  # error page) for a known-good id. Give up after ~30 min.
  local tries=0
  while [ "${tries}" -lt 180 ]; do
    if curl -s --max-time 15 'https://easyeda.com/api/products/C49851/components?version=6.4.19.5' \
         | head -c 1 | grep -q '{'; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 10
  done
  return 1
}

for id in "$@"; do
  if ! wait_easyeda; then echo "GIVEUP C${id} (easyeda still blocked)"; continue; fi
  out=$(ATO_NON_INTERACTIVE=1 ato create part -s "C${id}" -a 2>&1)
  name=$(echo "${out}" | grep -oE "Created [A-Za-z0-9_]+" | head -1 | sed "s/Created //")
  if [ -n "${name}" ]; then
    echo "OK C${id} -> ${name}"
  else
    echo "FAIL C${id}"
  fi
  sleep "${GEN_DELAY:-20}"
done
kill "${P}" 2>/dev/null
rm -rf "${WORK}"
echo "PATIENT-DONE"
