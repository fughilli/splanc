# FX agent authoring — static perf summary

Per-LED = shade + called functions, loops walked, all branch arms counted (upper bound).
Cycle estimate is rough (analyze.py COST), budget ~7700 cycles/LED for 500 LEDs at 30 fps
after ~2300 framing.

| variant  | model  | n   | compiled | 1st-try ok | mean calls | uses fixed | mean float transc./LED | mean float arith/LED | mean int/fixed/LED | plumbing % of ops | est. cyc/LED median / mean | fits 33ms | hoistable ops % | hoistable cyc % | memoizable cyc % | shade loops | mean lint hits |
| -------- | ------ | --- | -------- | ---------- | ---------- | ---------- | ---------------------- | -------------------- | ------------------ | ----------------- | -------------------------- | --------- | --------------- | --------------- | ---------------- | ----------- | -------------- |
| app      | opus   | 15  | 15/15    | 11/15      | 1.27       | 15/15      | 0.93                   | 10.73                | 27.53              | 59.21             | 10240 / 13666              | 6/15      | 3.43            | 2.67            | 11.76            | 2/15        | 3.13           |
| app      | sonnet | 15  | 15/15    | 10/15      | 1.33       | 9/15       | 0.53                   | 20.53                | 63.67              | 64.85             | 9130 / 28015               | 7/15      | 1.7             | 1.32            | 9.01             | 4/15        | 0.87           |
| app_lint | opus   | 15  | 15/15    | 10/10      | 0.67       | 15/15      | 0.07                   | 1.87                 | 36.93              | 59.95             | 9910 / 10132               | 7/15      | 1.48            | 1.24            | 13.15            | 1/15        | 0.27           |
| app_perf | opus   | 15  | 15/15    | 10/15      | 1.33       | 15/15      | 0                      | 2.47                 | 29.6               | 59.03             | 6850 / 8854                | 10/15     | 3.84            | 2.63            | 4.08             | 1/15        | 0.2            |
| skill    | opus   | 15  | 15/15    | 12/15      | 1.2        | 0/15       | 2.6                    | 40.53                | 0.13               | 62.7              | 16945 / 19927              | 1/15      | 9.53            | 9.3             | 5.23             | 1/15        | 3.67           |
| skill    | sonnet | 15  | 15/15    | 6/15       | 1.8        | 0/15       | 5.07                   | 34.67                | 0                  | 65.31             | 15575 / 23618              | 1/15      | 10.56           | 9.23            | 16.22            | 1/15        | 4.6            |

## Float heavy builtins per LED (mean over compiled programs)

| variant  | model  | sin  | cos  | tan | sqrt | exp  | log | pow  | atan2 | length | distance | normalize | smoothstep | hsv2rgb | palette | hash |
| -------- | ------ | ---- | ---- | --- | ---- | ---- | --- | ---- | ----- | ------ | -------- | --------- | ---------- | ------- | ------- | ---- |
| app      | opus   | 0.73 | 0.13 | 0   | 0    | 0    | 0   | 0    | 0.07  | 0      | 0        | 0         | 0          | 0       | 0       | 0.07 |
| app      | sonnet | 0.07 | 0    | 0   | 0    | 0    | 0   | 0    | 0.07  | 0      | 0        | 0         | 0.33       | 0.07    | 0       | 0.07 |
| app_lint | opus   | 0    | 0    | 0   | 0    | 0    | 0   | 0    | 0.07  | 0      | 0        | 0         | 0          | 0       | 0       | 0    |
| app_perf | opus   | 0    | 0    | 0   | 0    | 0    | 0   | 0    | 0     | 0      | 0        | 0         | 0          | 0       | 0       | 0    |
| skill    | opus   | 2.07 | 0.13 | 0   | 0    | 0    | 0   | 0    | 0.27  | 0.07   | 0        | 0         | 0          | 0.07    | 0       | 1.4  |
| skill    | sonnet | 0.87 | 0.33 | 0   | 0.07 | 0.07 | 0   | 0.07 | 0.47  | 0      | 0        | 0         | 3.07       | 0.13    | 0       | 2.93 |

## Perf-lint hits (hits / programs fired on)

| rule                     | app/opus | app/sonnet | app_lint/opus | app_perf/opus | skill/opus | skill/sonnet | all     |
| ------------------------ | -------- | ---------- | ------------- | ------------- | ---------- | ------------ | ------- |
| div_by_const             | 0 / 0    | 4 / 3      | 0 / 0         | 0 / 0         | 2 / 1      | 4 / 4        | 10 / 8  |
| exp_per_led              | 0 / 0    | 0 / 0      | 0 / 0         | 0 / 0         | 0 / 0      | 1 / 1        | 1 / 1   |
| float_literal_in_fixed   | 28 / 7   | 0 / 0      | 1 / 1         | 0 / 0         | 0 / 0      | 0 / 0        | 29 / 8  |
| float_trig_in_shade      | 12 / 3   | 1 / 1      | 0 / 0         | 0 / 0         | 29 / 9     | 14 / 7       | 56 / 20 |
| frame_invariant_in_shade | 4 / 4    | 2 / 2      | 1 / 1         | 2 / 2         | 10 / 10    | 17 / 9       | 36 / 28 |
| led_invariant_heavy      | 1 / 1    | 1 / 1      | 1 / 1         | 0 / 0         | 8 / 4      | 27 / 11      | 38 / 18 |
| length_compare           | 0 / 0    | 0 / 0      | 0 / 0         | 0 / 0         | 2 / 1      | 0 / 0        | 2 / 1   |
| loop_per_led             | 2 / 2    | 5 / 4      | 1 / 1         | 1 / 1         | 1 / 1      | 1 / 1        | 11 / 10 |
| noise_octaves_per_led    | 0 / 0    | 0 / 0      | 0 / 0         | 0 / 0         | 3 / 3      | 4 / 4        | 7 / 7   |
| pow_const_exponent       | 0 / 0    | 0 / 0      | 0 / 0         | 0 / 0         | 0 / 0      | 1 / 1        | 1 / 1   |
