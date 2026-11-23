// Two-thread pipeline: a "gateway" thread feeds order messages through the
// lock-free SPSC queue to a matching thread that owns the order book.
//
// Mode 1 (throughput): producer pushes as fast as it can; reports msgs/s.
// Mode 2 (latency):    producer paces messages at a fixed rate and stamps each
//                      with the TSC; the matching thread records
//                      enqueue -> dequeue -> matched latency per message.
//
// Usage: bench_pipeline [num_ops=5000000] [producer_cpu=2] [consumer_cpu=4] [rate_mps=1]

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <thread>
#include <vector>

#include "lob/order_book.hpp"
#include "lob/spsc_queue.hpp"
#include "order_flow.hpp"
#include "platform.hpp"

using namespace lob;
using namespace lob::bench;

namespace {

struct Msg {  // 32 bytes, two per cache line
  std::uint64_t ts;
  OrderId id;
  Price price;
  Qty qty;
  std::uint8_t kind;  // 0 add, 1 cancel, 2 stop
  Side side;
};
static_assert(sizeof(Msg) == 32);

using Queue = SpscQueue<Msg, 1u << 16>;

struct RunResult {
  double seconds = 0;
  std::vector<std::uint64_t> latency;  // TSC ticks, latency mode only
  std::uint64_t traded = 0;
};

RunResult run(const BookConfig& cfg, const std::vector<Op>& flow, int pcpu, int ccpu, std::uint64_t gap_ticks) {
  auto q = std::make_unique<Queue>();
  auto book = std::make_unique<OrderBook>(cfg);
  RunResult res;
  const bool record = gap_ticks > 0;
  if (record) res.latency.resize(flow.size());
  std::atomic<bool> consumer_ready{false};

  std::thread consumer([&] {
    pin_thread(ccpu);
    std::uint64_t traded = 0;
    auto on_trade = [&traded](const Trade& t) { traded += t.qty; };
    consumer_ready.store(true, std::memory_order_release);
    Msg m;
    std::size_t i = 0;
    while (!q->try_pop(m)) {
    }
    const auto t0 = std::chrono::steady_clock::now();
    for (;;) {
      if (m.kind == 2) break;
      if (m.kind == 0) book->add_limit(m.id, m.side, m.price, m.qty, on_trade);
      else book->cancel(m.id);
      if (record) res.latency[i] = tsc_now() - m.ts;
      ++i;
      while (!q->try_pop(m)) {
      }
    }
    res.seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    res.traded = traded;
  });

  std::thread producer([&] {
    pin_thread(pcpu);
    while (!consumer_ready.load(std::memory_order_acquire)) {
    }
    std::uint64_t next = tsc_now();
    for (const Op& op : flow) {
      Msg m{0, op.id, op.price, op.qty, static_cast<std::uint8_t>(op.kind == Op::Add ? 0 : 1), op.side};
      if (record) {
        while (tsc_now() < next) {
        }
        next += gap_ticks;
      }
      m.ts = tsc_now();
      while (!q->try_push(m)) {
      }
    }
    Msg stop{tsc_now(), 0, 0, 0, 2, Side::Buy};
    while (!q->try_push(stop)) {
    }
  });

  producer.join();
  consumer.join();
  return res;
}

}  // namespace

int main(int argc, char** argv) {
  const std::size_t n = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 5'000'000;
  const int pcpu = argc > 2 ? std::atoi(argv[2]) : 2;
  const int ccpu = argc > 3 ? std::atoi(argv[3]) : 4;
  const double rate_mps = argc > 4 ? std::atof(argv[4]) : 1.0;  // paced rate, millions of msgs/s

  BookConfig cfg;
  cfg.max_orders = 1u << 18;  // peak resting orders (live set stays ~50k), not total ops
  const auto flow = make_order_flow(n, 7, cfg);
  const double tsc_per_ns = calibrate_tsc_per_ns();

  std::printf("ops %zu | producer cpu %d -> consumer cpu %d | queue capacity %zu | TSC %.3f GHz\n\n", n, pcpu, ccpu,
              Queue::capacity(), tsc_per_ns);

  const RunResult tput = run(cfg, flow, pcpu, ccpu, 0);
  std::printf("throughput mode (unpaced)\n");
  std::printf("  %.2f M msgs/s through queue + matching engine (%.3f s)\n\n",
              static_cast<double>(n) / tput.seconds / 1e6, tput.seconds);

  const auto gap = static_cast<std::uint64_t>(tsc_per_ns * 1000.0 / rate_mps);
  RunResult lat = run(cfg, flow, pcpu, ccpu, gap);
  std::printf("latency mode (paced at %.1f M msgs/s): producer enqueue -> consumer dequeue -> matched\n", rate_mps);
  print_row("cross-thread + match", percentiles_ns(std::move(lat.latency), tsc_per_ns));
  if (lat.traded != tput.traded) {
    std::printf("MISMATCH between runs\n");
    return 1;
  }
  return 0;
}
