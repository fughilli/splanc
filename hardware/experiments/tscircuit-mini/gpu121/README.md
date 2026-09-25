# CPU/GPU placement kernels 121

Apple M4,10cores(4performance/6efficiency),16GiB shared RAM; Torch2.3.1 MPS available.
Use `PNR_BATCHED_WIRELENGTH=1` to select CPU degree-bucketed smooth wirelength in
`global_place`. Default remains legacy. All other placement terms and downstream
legality/electrical/native gates remain unchanged. Degree buckets limit padding
below2× actual pin entries; the initial all-net padded version was slower at
large batch sizes and is retained as experimental comparison code.

Actual Mini137components/574pins/74multi-pin nets: single-start forward1.604→0.149ms,
forward+gradient3.577→0.279ms. CPU bucket medians1/8/64starts .149/.208/.968ms;
MPS2.975/2.868/3.227ms. CPU wins this workload. GPU dispatch, padding and transfers
must be compared to the best CPU kernel, not only a Python per-net loop.

A complete continuous global_place call at200iterations, actual frozen Mini
constraints, seeds0/1/2 repeated twice: median1.02871→.26756s (3.84×). Both backends
repeat exactly, all fixed coordinates are preserved, rotations match. Floating
reduction order changes optimizer trajectories: maximum pose differences2.555,
.296,.463mm for the three seeds. This is NOT identical placement geometry, a
legalized placement or a routing improvement. The legalizer and full native
regression ladder remain required before enabling by default.

TP1 endpoint-cost experiment uses2019 unfiltered2mm candidate positions,20pads,
up to197peers. Existing Python299.23ms, NumPy84.43ms, Torch CPU34.02ms, MPS8.69ms
resident/9.23ms setup+transfer-inclusive. Setup-inclusive GPU rows are after backend
warmup, not cold-process startup; every timed row synchronizes completion. Actual
float64 ranking matched; float32 max value differences~.00125mm and tied rankings
changed. Observed true-cost inversions were only~9e-13mm and best regret0, but this
is not a general guarantee. MPS endpoint scoring stays benchmark-only; future
integration should refine shortlisted/cutoff ties with the original CPU scorer.
Array preparation .00026s; no legality or heavier capacity/Dijkstra cost is included.

`benchmark.py GRAPH.json OUTPUT` compares objective values/gradients and endpoint
ranking. `placement_ab.py GRAPH.json mini-constraints.yaml RESULTS.json` exercises
the full continuous placer with canonical address resolution, not empty rules.
Run with PnR numerical Python and PYTHONPATH=hardware/pnr. The source/module SHA,
raw samples, constraint SHA/warnings, repeated poses and candidate cost map are in
`output/perf121/gpu`. The 'mounting_hole' warning is inherited compiler behavior;
these microbenchmarks do not qualify mounting or enclosure geometry.

No GPU global-place/power/DRC acceleration is enabled. Future GPU trials should
batch complete independent starts or regular raster/dilation/heatmap stages only
if profiles justify them. Heap-based negotiated routing and137-node partitioning
stay CPU candidates. No new board outputs or large assets generated.
