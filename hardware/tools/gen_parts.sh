#!/usr/bin/env bash
# Regenerate the atomic atopile parts for a splanc hardware project from LCSC
# ids, using the local picker (hardware/tools/picker_catalog.json) + EasyEDA.
#
#   nix develop <rules_atopile> --command bash hardware/tools/gen_parts.sh \
#       <project-dir> <lcsc-id>...
#
# The generated parts land under <project-dir>/elec/src/parts and are committed
# so the board builds hermetically (picker=False). See hardware/README.md.
set -u
PROJ="${1:?usage: gen_parts.sh <project-dir> <lcsc-id>...}"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8099

# Serve the authoring catalog from a private copy (picker reads catalog.json
# next to server.py).
WORK="$(mktemp -d)"
cp "${HERE}/picker_server.py" "${WORK}/server.py"
cp "${HERE}/picker_catalog.json" "${WORK}/catalog.json"
python3 "${WORK}/server.py" "${PORT}" >/tmp/apick.log 2>&1 &
P=$!
sleep 2

cd "${PROJ}" || exit 1
for id in "$@"; do
  out=$(ATO_NON_INTERACTIVE=1 ato create part -s "C${id}" -a 2>&1)
  name=$(echo "${out}" | grep -oE "Created [A-Za-z0-9_]+" | head -1 | sed "s/Created //")
  if [ -n "${name}" ]; then
    echo "OK C${id} -> ${name}"
  else
    echo "FAIL C${id}"
    echo "${out}" | grep -iE "error|exception|not known|refused|no candidates|could not" | head -2
  fi
  # Space requests: EasyEDA's footprint API rate-limits rapid sequential fetches.
  sleep "${GEN_DELAY:-4}"
done
kill "${P}" 2>/dev/null
rm -rf "${WORK}"
