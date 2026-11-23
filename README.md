# Low-Latency Limit Order Book & Matching Engine

A single-instrument limit order book and price-time priority matching engine in C++20, built to keep the hot path free of heap allocation, pointer chasing, and locks. It ships with a lock-free SPSC queue for a gateway-to-matcher pipeline, TSC-based latency benchmarks, and a randomized differential test that replays millions of orders against a straightforward `std::map` reference book and requires identical results.

Header-only, no dependencies beyond the standard library.

**Live demo: [low-latency-order-book.vercel.app](https://low-latency-order-book.vercel.app)**

**Interactive demo:** the same engine compiled to WebAssembly, with a live order ladder, trade tape, an order ticket you can trade with, and an in-browser benchmark against the `std::map` book. Source in [`demo/`](demo); rebuild with `docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.74 sh demo/build.sh`.

## Results

Measured on a laptop (Intel Core i7-8565U, 4 cores / 8 threads, Windows 11, g++ 15.2 `-O3 -march=native`), thread pinned, 2M operations of synthetic order flow (55% adds, 45% cancels; about 1 in 10 operations is an aggressive order that crosses the spread). Latency is per operation, measured with serialized `rdtsc`/`rdtscp` with timer overhead subtracted. Numbers are the typical range across runs.

| | `lob::OrderBook` | `std::map` reference | Speedup |
|---|---|---|---|
| Throughput | **41 to 46 M ops/s** | 8.4 to 8.6 M ops/s | **4.8x to 5.4x** |
| Add (incl. matching), p50 | 33 to 45 ns | 147 ns | 3.3x to 4.5x |
| Add, p99 | 150 to 245 ns | 390 to 410 ns | 1.6x to 2.6x |
| Cancel, p50 | 21 to 26 ns | 64 ns | about 2.7x |
| Cancel, p99 | 165 to 230 ns | 270 to 320 ns | 1.2x to 1.6x |

Two-thread pipeline (gateway thread on CPU 2 pushes through the SPSC queue to the matching thread on CPU 4):

| | Result |
|---|---|
| Unpaced throughput, queue + matching | **19 M msgs/s** |
| Paced at 1M msgs/s, enqueue to matched, p50 | **about 170 ns** |
| Paced, p90 | 270 to 350 ns |

The pipeline's p99 and above on this machine range from a few microseconds to milliseconds. That tail comes from Windows scheduling interrupts and frequency changes on a laptop CPU, not from the engine; there is no core isolation here. On a Linux box with `isolcpus`, `nohz_full`, and a fixed CPU frequency the tail should tighten considerably. I have not measured that yet.

Both benchmarks check that the two books end with the same traded quantity and the same resting orders.

## Design

```
 gateway thread                         matching thread
 ┌──────────────┐   SpscQueue<Msg>    ┌─────────────────────────────────────────────┐
 │ order flow   │ ──────────────────▶ │ OrderBook                                   │
 │ (Msg, 32 B)  │   lock-free ring    │                                             │
 └──────────────┘   acquire/release   │  FlatIdMap: order id ──▶ pool index         │
                                      │  ObjectPool<Order>: preallocated, 32 B each │
                                      │  ladder[side][price - min]: Level {head,    │
                                      │      tail, total qty, count}                │
                                      │  occupancy bitset per side ──▶ best price   │
                                      └─────────────────────────────────────────────┘
```

**Price ladder instead of a tree.** Prices are integer ticks in a configured band, so each side is a flat array of `Level`s indexed by `price - min_price`. Finding a level is one array access, not a red-black tree walk. A `Level` is 16 bytes (head, tail, total quantity, order count).

**Occupancy bitset for best price.** Each side keeps one bit per price level. When the best level empties, the next best is found by scanning 64-bit words with `std::countr_zero` (asks) or `std::countl_zero` (bids), so a gap of 1,000 empty ticks costs about 16 word reads instead of 1,000 level checks.

**Intrusive FIFO per level.** Orders at a price form a doubly linked list threaded through the orders themselves, using 32-bit pool indices instead of pointers. An `Order` is 32 bytes (two per cache line). Cancel unlinks in O(1) from anywhere in the queue.

**Object pool, no allocation on the hot path.** All orders live in a preallocated `ObjectPool` with a LIFO free list, so a freed slot is reused while it is still warm in cache. The pool size is the maximum number of resting orders, set at construction. When it is full, new orders are rejected rather than allocated.

**Open-addressing id map.** `FlatIdMap` maps order id to pool index with linear probing, Fibonacci hashing, and backward-shift deletion (no tombstones, so probe chains do not degrade under heavy cancel churn). Capacity is a power of two at least 2x the order limit.

**Matching.** An incoming order walks the opposite side from the best price while it crosses, fills makers oldest first, prints each trade at the maker's price, and rests any remainder. Trades are delivered through a templated callback, so the compiler can inline the handler.

**SPSC queue.** A fixed-capacity ring with the producer index and consumer index on separate cache lines. Each side also caches its last view of the other side's index, so it only touches the shared line when the ring looks full or empty. Ordering is acquire/release only, no locks and no CAS.

### Complexity

| Operation | Cost |
|---|---|
| Add that rests | O(1) |
| Add that matches k orders | O(k + empty-level words scanned) |
| Cancel | O(1) expected (id map lookup + unlink + maybe a bitset scan) |
| Best bid / ask | O(1) (cached) |

## Correctness

`lob_tests` has 12 tests:

- Unit tests: resting and best prices, price-time priority, partial fills, multi-level sweeps, cancel from the middle of a queue, best price recovery across bitset words, rejection of bad orders (zero quantity, out-of-range price, duplicate id), and pool capacity limits.
- **Differential test:** 5 seeds x 400k operations on a narrow price band (lots of crossing and level churn) run through both `lob::OrderBook` and `ReferenceBook` (`std::map` + `std::list` + `std::unordered_map`). Every add result, every trade (maker, taker, price, quantity), every cancel result, and the full depth of both sides every 4,096 operations must match exactly.
- `FlatIdMap` against `std::unordered_map` over 500k random inserts, finds, and erases with dense colliding keys.
- SPSC queue wrap-around, full/empty reporting, and a two-thread run of 10M items checked for order and sum.

CI builds and runs the tests on Ubuntu with GCC and Clang.

## Build and run

Requires CMake 3.20+ and a C++20 compiler (GCC 11+ or Clang 14+). x86-64 only, because the benchmarks read the TSC.

```bash
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/lob_tests
./build/bench_latency  [num_ops=2000000] [cpu=2]
./build/bench_pipeline [num_ops=5000000] [producer_cpu=2] [consumer_cpu=4] [rate_mps=1]
```

On Windows this builds with MSYS2 MinGW-w64 (`pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake mingw-w64-x86_64-ninja`); the binaries are linked statically.

For the pipeline benchmark, pick two CPUs on different physical cores. On a 4-core / 8-thread Intel part, logical CPUs 2 and 4 usually are.

## Using the book

```cpp
#include "lob/order_book.hpp"

lob::BookConfig cfg;            // price band in ticks + max resting orders
cfg.min_price = 0;
cfg.max_price = 65535;
cfg.max_orders = 1 << 18;

lob::OrderBook book(cfg);
auto on_trade = [](const lob::Trade& t) { /* t.maker, t.taker, t.price, t.qty */ };

book.add_limit(1, lob::Side::Sell, 10100, 50, on_trade);   // rests
book.add_limit(2, lob::Side::Buy,  10105, 80, on_trade);   // fills 50 @ 10100, rests 30 @ 10105
book.cancel(2);
auto bid = book.best_bid();                                  // std::optional<Price>
```

## Layout

```
include/lob/
  types.hpp           ids, prices, Trade, BookConfig
  order_book.hpp      the matching engine
  object_pool.hpp     preallocated slots + LIFO free list
  flat_id_map.hpp     open-addressing order id -> slot map
  spsc_queue.hpp      lock-free single-producer single-consumer ring
  reference_book.hpp  std::map baseline, used by tests and benchmarks
bench/
  order_flow.hpp      deterministic synthetic order flow (random-walk mid price)
  platform.hpp        thread pinning, TSC timing, percentiles
  bench_latency.cpp   single-thread throughput + per-op latency vs baseline
  bench_pipeline.cpp  gateway -> SPSC -> matcher, throughput and paced latency
tests/
  test_main.cpp       unit + differential tests
demo/
  wasm/lob_wasm.cpp   C ABI over the engine for Emscripten
  site/               static page (HTML/CSS/JS) + compiled lob.js / lob.wasm
```

## Limitations and next steps

- Single instrument and limit orders only. No market, IOC, FOK, or order modify yet (modify is a cancel plus add today, which loses queue priority).
- The price band is fixed at construction. A very wide band costs memory and longer bitset scans when the book is sparse; a two-level bitset (one summary bit per 64-bit word) would bound the scan.
- Synthetic order flow. The next step is driving the book from real exchange data with a Nasdaq ITCH 5.0 feed handler.
- Tail latency was measured on a laptop without core isolation. Linux numbers with `isolcpus` and `perf stat` cache-miss counts are next.
