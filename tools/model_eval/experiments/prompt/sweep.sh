#!/bin/bash
# Sequential sweep over all exp_prompt.ts variants. Writes results-<v>.json each.
cd /workspace/tools/model_eval || exit 1
LOG=experiments/prompt/run.log
for v in examples antipatterns feedback combined baseline3; do
  if [ -s "experiments/prompt/results-$v.json" ]; then
    echo "=== VARIANT $v (already have results, skipping) ===" >> "$LOG"
    continue
  fi
  echo "=== VARIANT $v ($(date -u +%H:%M:%S)) ===" >> "$LOG"
  npx tsx src/exp_prompt.ts --variant="$v" --rounds=3 >> "$LOG" 2> >(grep -viE 'llama|ggml|gguf|Metal|deprecat' >> "$LOG")
  echo "--- variant $v exit=$? ($(date -u +%H:%M:%S)) ---" >> "$LOG"
done
touch experiments/prompt/SWEEP_DONE
