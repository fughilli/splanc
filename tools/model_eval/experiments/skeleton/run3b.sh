#!/bin/bash
# Retry wrapper: wait for RAM, run the skeleton sweep for qwen2.5-3b only,
# retry on OOM/crash until results-3b.json contains 4 cells.
cd /workspace/tools/model_eval || exit 1
OUT=experiments/skeleton/results-3b.json
LOG=experiments/skeleton/sweep-3b.log
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  n=$(python3 -c "import json;print(len(json.load(open('$OUT'))['cells']))" 2>/dev/null || echo 0)
  if [ "$n" -ge 4 ]; then echo "DONE after $((attempt-1)) attempts" >> "$LOG"; exit 0; fi
  # wait for enough available memory (weights are mmap'd; ~1.5G anon needed, be safe)
  until [ "$(free -m | awk '/^Mem:/{print $7}')" -gt 3300 ]; do sleep 30; done
  echo "=== attempt $attempt $(date -u +%H:%M:%S) avail=$(free -m | awk '/^Mem:/{print $7}')MB ===" >> "$LOG"
  npx tsx src/exp_skeleton.ts --models=qwen2.5-3b-instruct --out="$OUT" >> "$LOG" 2>&1
  echo "=== attempt $attempt exited rc=$? ===" >> "$LOG"
  sleep 20
done
echo "GAVE UP" >> "$LOG"
exit 1
