# Post-boot heap census

The log-only freeze trap from step 2 of the plan in `memory-regions.md` (lands with #263); see also [ram-budget.md](ram-budget.md). After `setup()` calls `lm_heap_freeze()`, every allocation through the IDF heap is attributed to its call site.

The census table is `LM_HEAP_CENSUS` (`firmware/player_app/heap_census*.{h,cc,cpp}`):
- per-site counts, bytes, live bytes and the largest request;
- a ring of the newest 128 events;
- a pointer map that attributes frees back to the site that allocated.

The DUT never reports it. `//pi/hitl/harness:ram_audit` reads the struct over JTAG at the end of a run and symbolizes it against the ELF (`pi/hitl/harness/heap_census.py`), writing `census.md`.

```
bazel build -c opt --//firmware/player_app:heap_census_enabled //pi/hitl/harness:ram_audit
bazel-bin/pi/hitl/harness/ram_audit --server http://hitl-rig-2:8087 --thresh 1000 --out /tmp/ra
```

It's a diagnostic build, off by default, and costs about 12 KB of RAM: the 9.8 KB table plus about 2.6 KB of IRAM shims.

**How it hooks the heap.** On the C6, newlib's `malloc`, `realloc`, `_malloc_r` and `free` are tail jumps into libheap, so `--wrap`ping libheap's entry points keeps the original caller's return address:
- `heap_caps_malloc_default` and `_realloc_default`;
- `heap_caps_malloc`, `_calloc`, `_realloc`, `_free`, `_aligned_alloc` and `_aligned_calloc`.

`calloc` calls into libheap with a `jal`, so it's wrapped itself, and the inner allocation it makes is skipped. Direct `heap_caps_*` users are attributed to the adapter function that called the heap: the WiFi/BLE OS adapters, `pvPortMalloc` and drivers. The shims and bookkeeping are in IRAM, record under an ISR-safe critical section, and never allocate or block.

## First census — 2026-10-19

The run was the `ram_audit` worst case on rig-2 c6-fa0324 (BLE provisioning, then wss, then a 512-LED map, then a texture effect, then 3 loaded handshakes): PASS, 3/3 rounds, cert 3/3.
- Frozen at 4,277 ms. Before that: 519 allocations, 124 KB (boot, one-time).
- After the freeze: 2,256 allocations, 1.24 MB requested in total, 2,228 frees, 0 failures, no table overflow.
- About 3.9 KB was still live at the end, so there is no leak.

| call site | allocs | bytes | live | max | reading | kind | move to |
|---|---:|---:|---:|---:|---|---|---|
| `esp_mbedtls_mem_calloc+0x26` | 1,573 | 1,158,774 | 1,685 | 6,818 | mbedTLS: the `DYNAMIC_BUFFER` record in/out buffers (6,485 B) are allocated and freed per record, plus mpi/ecp/x509 handshake churn | **churn, the fragmentation risk**. The 6.5 KB records are the contiguous-block failure mode | TLS slab: two fixed record slots for the one session, plus a small-block slab (`MBEDTLS_PLATFORM_MEMORY`); plan step 5 |
| `0x400281cc` (ROM) | 10 | 40,960 | 0 | 4,096 | Almost certainly ROM newlib stdio allocating each FILE's buffer at `st_blksize` (4 KB) on a littlefs `fopen`. It always fires together with `vfs_littlefs_open` (map/topology/effect saves and replays) | churn of **4 KB blocks** | `setvbuf(f, NULL, _IONBF, 0)` (or a static buffer) in `fs_write_file` / `fs_replay` / the upload temp file |
| `r_ble_ll_mem_alloc+0x22` | 242 | 17,420 | 1,440 | 324 | BLE controller (`bt_osi`) link-layer buffers | churn, small | BLE slab via `--wrap=bt_osi_mem_*` |
| `vfs_littlefs_open+0x172` | 10 | 6,599 | 0 | 660 | littlefs file handle per open | churn per file op | a static pool of 2 file slots |
| `Print::vprintf+0x78` | 91 | 6,519 | 0 | 116 | Arduino `Print::printf` mallocs for lines over its 64 B stack buffer (direct `Serial.printf` diagnostics) | churn, small | route through `Log()` (fixed ring), or enlarge the buffer |
| `esp_aes_process_dma+0x1b6` | 195 | 4,848 | 0 | 48 | HW-AES DMA descriptors per TLS record | churn, small | AES descriptor pool |
| `ns_ble_on_hci+0x166`, `+0x11e`, `player_ble_poll+0x56` | 3 | 5,380 | 0 | 2,052 | BLE player transport RX/TX buffers and the 1.5 KB frame, per central connection | per connection | fixed slots in the BLE region |
| `esp_partition_find+0x2e` | 102 | 2,040 | 0 | 20 | partition iterator per littlefs operation | churn, tiny | look the partition up once |
| `xQueueGenericCreate+0x2e` | 15 | 1,380 | 460 | 92 | driver locks created at the first TLS handshake, plus per-op mutexes | mostly one-time, lazy | static creation |
| `gdma_new_channel+*` | 7 | 432 | 136 | 120 | the HW-AES GDMA channel, created at the first handshake | one-time, lazy | move to boot |
| `calloc+0x1a` | 3 | 184 | 184 | 132 | `calloc` called from ROM (newlib stdio `__sfp` / `_reent` glue) | one-time | goes with the stdio fix |
| `esp_timer_create`, `esp_wifi_set_channel`, `get_desc_for_int`, `esp_intr_alloc_intrstatus_bind` | 4 | 80 | 48 | 32 | coex timer, WiFi ioctl marshal, PARLIO interrupt descriptor | one-time | fine |

**What this changes in the plan:**
1. **mbedTLS is 93% of post-boot bytes.** It is also the only churn of large blocks besides stdio. The TLS slab (step 5) is the highest-value migration and removes the 6.5 KB contiguous requirement.
2. **stdio FILE buffers churn 4 KB blocks** on every littlefs open. A near-free fix (`setvbuf`) closes the second-largest contiguous-block risk.
3. **The BLE slab now has a measured size:** about 1.4 KB live, ≤ 324 B per block, 242 allocations.
4. **The rest is small or one-time:** fixed pools or call-site fixes.
5. **The WiFi driver made no post-freeze heap allocations:** the netstack owns RX/TX, and the vendor adapter's mallocs all happen before the freeze.
