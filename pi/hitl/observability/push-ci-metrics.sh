#!/usr/bin/env bash
# Push one HITL CI run's result to Grafana Cloud Loki as a structured log event.
#
# Why Loki and not Prometheus: a CI job is a discrete, ephemeral event, not a
# scrape target. Prometheus wants to pull long-lived series; pushing per-run
# counters from throwaway runners needs a pushgateway and aggregates badly. Loki
# stores the event verbatim, and LogQL turns it back into a rate/ratio for a
# panel (e.g. pass-rate = count_over_time(result="pass") / count_over_time(...)).
# This is the *optional, richer* path; the zero-code baseline is Grafana Cloud's
# GitHub integration (see observability/README.md).
#
# No-op (exit 0) when the Loki creds are absent — so it's safe to wire into CI
# unconditionally, including on fork PRs that can't read the secrets.
#
# Env (from the "HITL" GitHub Actions environment):
#   GRAFANA_CLOUD_LOKI_URL   https://logs-prod-REGION.grafana.net/loki/api/v1/push
#   GRAFANA_CLOUD_LOKI_USER  numeric logs instance id
#   GRAFANA_CLOUD_LOKI_KEY   access-policy token scoped to logs:write
# Args (or the matching env var):
#   --result <pass|fail>   RESULT      required
#   --job <name>           JOB         test target / job name       (default: hitl)
#   --pr <number>          PR          PR number                    (default: "")
#   --commit <sha>         COMMIT      commit sha                   (default: "")
#   --duration <seconds>   DURATION    wall-clock seconds           (default: "")
set -euo pipefail

RESULT="${RESULT:-}"
JOB="${JOB:-hitl}"
PR="${PR:-}"
COMMIT="${COMMIT:-}"
DURATION="${DURATION:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --result)   RESULT="$2";   shift 2 ;;
    --job)      JOB="$2";      shift 2 ;;
    --pr)       PR="$2";       shift 2 ;;
    --commit)   COMMIT="$2";   shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${GRAFANA_CLOUD_LOKI_URL:-}" ] || [ -z "${GRAFANA_CLOUD_LOKI_KEY:-}" ]; then
  echo "push-ci-metrics: Loki creds unset; skipping CI metric push." >&2
  exit 0
fi
if [ -z "$RESULT" ]; then
  echo "push-ci-metrics: --result is required" >&2
  exit 2
fi

# Loki wants a nanosecond unix timestamp as a string.
ts_ns="$(date +%s)000000000"

# Stream labels are low-cardinality (job, result); the volatile PR/commit/duration
# ride in the log line so they don't explode Loki's index.
line="pr=${PR} commit=${COMMIT} duration_seconds=${DURATION} result=${RESULT}"

payload=$(cat <<JSON
{"streams":[{"stream":{"job":"hitl-ci","hitl_job":"${JOB}","result":"${RESULT}"},"values":[["${ts_ns}","${line}"]]}]}
JSON
)

code=$(curl -s -o /dev/null -w '%{http_code}' \
  -u "${GRAFANA_CLOUD_LOKI_USER}:${GRAFANA_CLOUD_LOKI_KEY}" \
  -H 'Content-Type: application/json' \
  -X POST "${GRAFANA_CLOUD_LOKI_URL}" \
  --data-binary "${payload}")

if [ "$code" != "204" ]; then
  echo "push-ci-metrics: Loki push returned HTTP ${code}" >&2
  exit 1
fi
echo "push-ci-metrics: pushed result=${RESULT} job=${JOB} pr=${PR} to Loki."
