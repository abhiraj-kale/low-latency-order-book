// Single-threaded book benchmark: throughput and per-operation latency of
// lob::OrderBook vs the std::map-based ReferenceBook on identical order flow.
//
// Usage: bench_latency [num_ops=2000000] [cpu=2]

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include "lob/order_book.hpp"
#include "lob/reference_book.hpp"
#include "order_flow.hpp"
#include "platform.hpp"

using namespace lob;
using namespace lob::bench;

namespace {

struct Result {
  double mops = 0;
  Percentiles add{}, cancel{}, all{};
  std::uint64_t traded_qty = 0;
  std::size_t resting = 0;
};

template <class Book>
Result run(const BookConfig& cfg, const std::vector<Op>& flow, std::uint64_t overhead, double tsc_per_ns) {
  Result r;
  // Pass 1: raw throughput, no per-op timestamps.
  {
    auto book = std::make_unique<Book>(cfg);
    std::uint64_t traded = 0;
    auto on_trade = [&traded](const Trade& t) { traded += t.qty; };
    const auto t0 = std::chrono::steady_clock::now();
    for (const Op& op : flow) {
      if (op.kind == Op::Add) book->add_limit(op.id, op.side, op.price, op.qty, on_trade);
      else book->cancel(op.id);
    }
    const auto t1 = std::chrono::steady_clock::now();
    const double secs = std::chrono::duration<double>(t1 - t0).count();
    r.mops = static_cast<double>(flow.size()) / secs / 1e6;
    r.traded_qty = traded;
    r.resting = book->order_count();
  }
  // Pass 2: per-operation latency on a fresh book.
  {
    auto book = std::make_unique<Book>(cfg);
    std::uint64_t traded = 0;
    auto on_trade = [&traded](const Trade& t) { traded += t.qty; };
    std::vector<std::uint64_t> adds, cancels, all;
    adds.reserve(flow.size());
    cancels.reserve(flow.size());
    all.reserve(flow.size());
    for (const Op& op : flow) {
      const std::uint64_t a = tsc_begin();
      if (op.kind == Op::Add) book->add_limit(op.id, op.side, op.price, op.qty, on_trade);
      else book->cancel(op.id);
      const std::uint64_t b = tsc_end();
      const std::uint64_t d = (b - a > overhead) ? (b - a - overhead) : 0;
      (op.kind == Op::Add ? adds : cancels).push_back(d);
      all.push_back(d);
    }
    if (traded != r.traded_qty) std::printf("  warning: traded qty differs between passes\n");
    r.add = percentiles_ns(std::move(adds), tsc_per_ns);
    r.cancel = percentiles_ns(std::move(cancels), tsc_per_ns);
    r.all = percentiles_ns(std::move(all), tsc_per_ns);
  }
  return r;
}

void report(const char* name, const Result& r) {
  std::printf("%s\n", name);
  std::printf("  throughput                 %.2f M ops/s\n", r.mops);
  print_row("add (incl. matching)", r.add);
  print_row("cancel", r.cancel);
  print_row("all ops", r.all);
}

}  // namespace

int main(int argc, char** argv) {
  const std::size_t n = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 2'000'000;
  const int cpu = argc > 2 ? std::atoi(argv[2]) : 2;

  BookConfig cfg;
  cfg.min_price = 0;
  cfg.max_price = 65535;
  cfg.max_orders = 1u << 18;  // peak resting orders (live set stays ~50k), not total ops

  const bool pinned = pin_thread(cpu);
  const double tsc_per_ns = calibrate_tsc_per_ns();
  const std::uint64_t overhead = measure_tsc_overhead();
  const auto flow = make_order_flow(n, 42, cfg);

  std::size_t adds = 0;
  for (const Op& op : flow) adds += (op.kind == Op::Add);
  std::printf("ops %zu (adds %zu, cancels %zu) | cpu %d%s | TSC %.3f GHz | timer overhead %llu ticks subtracted\n\n",
              n, adds, n - adds, cpu, pinned ? " (pinned)" : " (not pinned)", tsc_per_ns,
              static_cast<unsigned long long>(overhead));

  const Result fast = run<OrderBook>(cfg, flow, overhead, tsc_per_ns);
  const Result ref = run<ReferenceBook>(cfg, flow, overhead, tsc_per_ns);

  report("lob::OrderBook (flat ladder + pool + flat hash)", fast);
  std::printf("\n");
  report("ReferenceBook (std::map + std::list + unordered_map)", ref);

  std::printf("\nspeedup: throughput %.1fx | p50 add %.1fx | p99 add %.1fx | p99 cancel %.1fx\n", fast.mops / ref.mops,
              ref.add.p50 / (fast.add.p50 > 0 ? fast.add.p50 : 1), ref.add.p99 / (fast.add.p99 > 0 ? fast.add.p99 : 1),
              ref.cancel.p99 / (fast.cancel.p99 > 0 ? fast.cancel.p99 : 1));
  if (fast.traded_qty != ref.traded_qty || fast.resting != ref.resting) {
    std::printf("MISMATCH: books disagree (traded %llu vs %llu, resting %zu vs %zu)\n",
                static_cast<unsigned long long>(fast.traded_qty), static_cast<unsigned long long>(ref.traded_qty),
                fast.resting, ref.resting);
    return 1;
  }
  std::printf("books agree: traded qty %llu, resting orders %zu\n", static_cast<unsigned long long>(fast.traded_qty),
              fast.resting);
  return 0;
}
