// Self-contained test runner (no external dependencies).
//   - Unit tests for matching semantics, the id map, and the SPSC queue.
//   - Randomized differential test: millions of operations replayed against
//     both lob::OrderBook and the std::map ReferenceBook; every trade, every
//     result code, and the full depth of both sides must match exactly.

#include <cstdio>
#include <functional>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <vector>

#include "lob/flat_id_map.hpp"
#include "lob/order_book.hpp"
#include "lob/reference_book.hpp"
#include "lob/spsc_queue.hpp"
#include "order_flow.hpp"

using namespace lob;

namespace {

struct TestCase {
  const char* name;
  std::function<void()> fn;
};
std::vector<TestCase>& registry() {
  static std::vector<TestCase> r;
  return r;
}
struct Register {
  Register(const char* n, std::function<void()> f) { registry().push_back({n, std::move(f)}); }
};
int g_failures = 0;

#define TEST(name)                                     \
  void name();                                         \
  const Register reg_##name(#name, name);              \
  void name()

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      ++g_failures;                                                              \
      std::printf("    CHECK failed: %s  (%s:%d)\n", #cond, __FILE__, __LINE__); \
    }                                                                            \
  } while (0)

BookConfig small_cfg() {
  BookConfig c;
  c.min_price = 0;
  c.max_price = 1000;
  c.max_orders = 1024;
  return c;
}

using Trades = std::vector<Trade>;
auto collect(Trades& t) {
  return [&t](const Trade& x) { t.push_back(x); };
}
auto ignore() {
  return [](const Trade&) {};
}

}  // namespace

// ---------------------------------------------------------------- matching

TEST(resting_orders_set_best_prices) {
  OrderBook b(small_cfg());
  CHECK(!b.best_bid() && !b.best_ask());
  CHECK(b.add_limit(1, Side::Buy, 99, 10, ignore()) == AddResult::Rested);
  CHECK(b.add_limit(2, Side::Buy, 98, 10, ignore()) == AddResult::Rested);
  CHECK(b.add_limit(3, Side::Sell, 101, 10, ignore()) == AddResult::Rested);
  CHECK(b.best_bid() == 99 && b.best_ask() == 101);
  CHECK(b.depth_at(Side::Buy, 99) == 10 && b.order_count() == 3);
}

TEST(price_time_priority_fills_oldest_first) {
  OrderBook b(small_cfg());
  b.add_limit(1, Side::Sell, 100, 5, ignore());
  b.add_limit(2, Side::Sell, 100, 5, ignore());
  Trades t;
  CHECK(b.add_limit(3, Side::Buy, 100, 7, collect(t)) == AddResult::Filled);
  CHECK(t.size() == 2);
  CHECK((t[0] == Trade{1, 3, 100, 5}));
  CHECK((t[1] == Trade{2, 3, 100, 2}));
  CHECK(b.depth_at(Side::Sell, 100) == 3);
}

TEST(partial_fill_rests_remainder) {
  OrderBook b(small_cfg());
  b.add_limit(1, Side::Sell, 100, 4, ignore());
  Trades t;
  CHECK(b.add_limit(2, Side::Buy, 102, 10, collect(t)) == AddResult::Rested);
  CHECK(t.size() == 1 && t[0].qty == 4 && t[0].price == 100);  // prints at maker price
  CHECK(b.best_bid() == 102 && !b.best_ask());
  CHECK(b.depth_at(Side::Buy, 102) == 6);
}

TEST(sweep_walks_levels_in_price_order) {
  OrderBook b(small_cfg());
  b.add_limit(1, Side::Sell, 103, 1, ignore());
  b.add_limit(2, Side::Sell, 101, 1, ignore());
  b.add_limit(3, Side::Sell, 102, 1, ignore());
  Trades t;
  b.add_limit(4, Side::Buy, 102, 5, collect(t));
  CHECK(t.size() == 2 && t[0].price == 101 && t[1].price == 102);
  CHECK(b.best_ask() == 103 && b.best_bid() == 102);
}

TEST(cancel_middle_of_queue_keeps_fifo) {
  OrderBook b(small_cfg());
  b.add_limit(1, Side::Buy, 50, 1, ignore());
  b.add_limit(2, Side::Buy, 50, 1, ignore());
  b.add_limit(3, Side::Buy, 50, 1, ignore());
  CHECK(b.cancel(2));
  CHECK(!b.cancel(2));
  CHECK(!b.cancel(999));
  Trades t;
  b.add_limit(4, Side::Sell, 50, 2, collect(t));
  CHECK(t.size() == 2 && t[0].maker == 1 && t[1].maker == 3);
}

TEST(for_each_order_walks_the_queue_front_first) {
  OrderBook b(small_cfg());
  for (OrderId id = 1; id <= 5; ++id) b.add_limit(id, Side::Sell, 70, static_cast<Qty>(id * 10), ignore());
  b.cancel(3);
  b.add_limit(9, Side::Buy, 70, 15, ignore());  // takes all of 1 (10) and 5 of 2
  std::vector<std::pair<OrderId, Qty>> q;
  b.for_each_order(Side::Sell, 70, [&](OrderId id, Qty qty) { q.emplace_back(id, qty); });
  CHECK((q == std::vector<std::pair<OrderId, Qty>>{{2, 15}, {4, 40}, {5, 50}}));
}

TEST(best_price_recovers_after_level_empties) {
  OrderBook b(small_cfg());
  b.add_limit(1, Side::Buy, 10, 1, ignore());
  b.add_limit(2, Side::Buy, 700, 1, ignore());  // far apart: spans many bitset words
  b.add_limit(3, Side::Sell, 900, 1, ignore());
  b.add_limit(4, Side::Sell, 950, 1, ignore());
  CHECK(b.cancel(2) && b.best_bid() == 10);
  CHECK(b.cancel(3) && b.best_ask() == 950);
  CHECK(b.cancel(1) && !b.best_bid());
}

TEST(rejects_invalid_orders) {
  OrderBook b(small_cfg());
  CHECK(b.add_limit(1, Side::Buy, 10, 0, ignore()) == AddResult::Rejected);     // zero qty
  CHECK(b.add_limit(1, Side::Buy, 1001, 1, ignore()) == AddResult::Rejected);   // above range
  CHECK(b.add_limit(1, Side::Buy, -1, 1, ignore()) == AddResult::Rejected);     // below range
  CHECK(b.add_limit(kInvalidId, Side::Buy, 5, 1, ignore()) == AddResult::Rejected);
  CHECK(b.add_limit(1, Side::Buy, 10, 1, ignore()) == AddResult::Rested);
  CHECK(b.add_limit(1, Side::Sell, 20, 1, ignore()) == AddResult::Rejected);    // duplicate id
}

TEST(pool_capacity_is_enforced) {
  BookConfig c = small_cfg();
  c.max_orders = 2;
  OrderBook b(c);
  CHECK(b.add_limit(1, Side::Buy, 10, 1, ignore()) == AddResult::Rested);
  CHECK(b.add_limit(2, Side::Buy, 11, 1, ignore()) == AddResult::Rested);
  CHECK(b.add_limit(3, Side::Buy, 12, 1, ignore()) == AddResult::Rejected);
  CHECK(b.cancel(1));
  CHECK(b.add_limit(3, Side::Buy, 12, 1, ignore()) == AddResult::Rested);  // slot reused
}

// ---------------------------------------------------------------- differential

namespace {

using Depth = std::vector<std::tuple<Price, Qty, std::uint32_t>>;
template <class Book>
Depth depth(const Book& b, Side s) {
  Depth d;
  b.for_each_level(s, [&d](Price p, Qty q, std::uint32_t c) { d.emplace_back(p, q, c); });
  return d;
}

// Every queue on one side, order by order, in time priority.
using Queues = std::vector<std::pair<OrderId, Qty>>;
template <class Book>
Queues queues(const Book& b, Side s) {
  Queues out;
  b.for_each_level(s, [&](Price p, Qty, std::uint32_t) {
    b.for_each_order(s, p, [&](OrderId id, Qty q) { out.emplace_back(id, q); });
  });
  return out;
}

void differential_run(std::uint64_t seed, std::size_t n) {
  BookConfig cfg;
  cfg.min_price = 0;
  cfg.max_price = 4095;  // narrow range: lots of crossing and level churn
  cfg.max_orders = static_cast<std::uint32_t>(n);
  const auto flow = bench::make_order_flow(n, seed, cfg);
  auto fast = std::make_unique<OrderBook>(cfg);
  auto ref = std::make_unique<ReferenceBook>(cfg);
  Trades tf, tr;
  std::size_t trades = 0;
  for (std::size_t i = 0; i < flow.size(); ++i) {
    const auto& op = flow[i];
    tf.clear();
    tr.clear();
    if (op.kind == bench::Op::Add) {
      const AddResult a = fast->add_limit(op.id, op.side, op.price, op.qty, collect(tf));
      const AddResult r = ref->add_limit(op.id, op.side, op.price, op.qty, collect(tr));
      if (a != r || tf != tr) {
        CHECK(a == r);
        CHECK(tf == tr);
        std::printf("    diverged at op %zu (seed %llu)\n", i, static_cast<unsigned long long>(seed));
        return;
      }
      trades += tf.size();
    } else if (fast->cancel(op.id) != ref->cancel(op.id)) {
      CHECK(false);
      std::printf("    cancel diverged at op %zu\n", i);
      return;
    }
    if ((i & 4095) == 0 || i + 1 == flow.size()) {
      if (depth(*fast, Side::Buy) != depth(*ref, Side::Buy) || depth(*fast, Side::Sell) != depth(*ref, Side::Sell) ||
          queues(*fast, Side::Buy) != queues(*ref, Side::Buy) || queues(*fast, Side::Sell) != queues(*ref, Side::Sell) ||
          fast->order_count() != ref->order_count()) {
        CHECK(false);
        std::printf("    depth diverged at op %zu\n", i);
        return;
      }
    }
  }
  std::printf("    seed %llu: %zu ops, %zu trades, %zu resting, identical\n", static_cast<unsigned long long>(seed), n,
              trades, fast->order_count());
}

}  // namespace

TEST(differential_vs_reference_book) {
  for (std::uint64_t seed = 1; seed <= 5; ++seed) differential_run(seed, 400'000);
}

// ---------------------------------------------------------------- flat id map

TEST(flat_id_map_matches_unordered_map) {
  FlatIdMap m(5000);
  std::unordered_map<OrderId, std::uint32_t> ref;
  std::mt19937_64 rng(3);
  std::uniform_int_distribution<OrderId> key(1, 8000);  // dense keys: many collisions and erasures
  for (int i = 0; i < 500'000; ++i) {
    const OrderId k = key(rng);
    if (rng() & 1) {
      const bool can = ref.size() < 5000 && !ref.count(k);
      CHECK(m.insert(k, static_cast<std::uint32_t>(i)) == can);
      if (can) ref[k] = static_cast<std::uint32_t>(i);
    } else {
      CHECK(m.erase(k) == (ref.erase(k) == 1));
    }
    const auto it = ref.find(k);
    CHECK(m.find(k) == (it == ref.end() ? kNull : it->second));
  }
  CHECK(m.size() == ref.size());
}

// ---------------------------------------------------------------- spsc queue

TEST(spsc_wraps_and_reports_full_empty) {
  SpscQueue<int, 4> q;
  int v = 0;
  CHECK(!q.try_pop(v));
  for (int round = 0; round < 10; ++round) {
    for (int i = 0; i < 4; ++i) CHECK(q.try_push(round * 10 + i));
    CHECK(!q.try_push(-1));
    for (int i = 0; i < 4; ++i) CHECK(q.try_pop(v) && v == round * 10 + i);
    CHECK(!q.try_pop(v));
  }
}

TEST(spsc_two_threads_preserve_order) {
  constexpr std::uint64_t kN = 10'000'000;
  auto q = std::make_unique<SpscQueue<std::uint64_t, 1024>>();
  bool in_order = true;
  std::uint64_t sum = 0;
  std::thread consumer([&] {
    std::uint64_t expect = 0, v;
    while (expect < kN) {
      if (q->try_pop(v)) {
        if (v != expect) in_order = false;
        sum += v;
        ++expect;
      }
    }
  });
  for (std::uint64_t i = 0; i < kN; ++i) {
    while (!q->try_push(i)) {
    }
  }
  consumer.join();
  CHECK(in_order);
  CHECK(sum == kN * (kN - 1) / 2);
}

int main() {
  int failed_tests = 0;
  for (const auto& t : registry()) {
    const int before = g_failures;
    std::printf("[ RUN  ] %s\n", t.name);
    t.fn();
    const bool ok = g_failures == before;
    if (!ok) ++failed_tests;
    std::printf("[ %s ] %s\n", ok ? " OK " : "FAIL", t.name);
  }
  std::printf("\n%zu tests, %d failed\n", registry().size(), failed_tests);
  return failed_tests == 0 ? 0 : 1;
}
