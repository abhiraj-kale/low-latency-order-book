// C ABI over lob::OrderBook for the browser demo (compiled with Emscripten).
// The page drives the book through these functions and reads trades and depth
// straight out of WASM memory, so nothing is serialized on the way out.

#include <emscripten/emscripten.h>

#include <cstdint>
#include <memory>

#include "lob/order_book.hpp"
#include "lob/reference_book.hpp"
#include "order_flow.hpp"

using namespace lob;

namespace {

struct TradeOut {  // 24 bytes, read from JS as Uint32/Int32 views
  std::uint32_t maker;
  std::uint32_t taker;
  std::int32_t price;
  std::uint32_t qty;
  std::uint32_t taker_side;  // 0 buy, 1 sell
  std::uint32_t pad;
};

constexpr int kMaxTrades = 4096;
constexpr int kMaxDepth = 256;

std::unique_ptr<OrderBook> g_book;
TradeOut g_trades[kMaxTrades];
int g_trade_count = 0;
std::int32_t g_depth[2][kMaxDepth * 3];  // per side: price, total qty, order count
double g_bench[8];

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void lob_init(int min_price, int max_price, int max_orders) {
  BookConfig cfg;
  cfg.min_price = min_price;
  cfg.max_price = max_price;
  cfg.max_orders = static_cast<std::uint32_t>(max_orders);
  g_book = std::make_unique<OrderBook>(cfg);
  g_trade_count = 0;
}

// Returns 0 rested, 1 filled, 2 rejected. Trades accumulate until lob_clear_trades.
EMSCRIPTEN_KEEPALIVE int lob_add(std::uint32_t id, int side, int price, std::uint32_t qty) {
  const Side s = side == 0 ? Side::Buy : Side::Sell;
  const AddResult r = g_book->add_limit(id, s, price, qty, [side](const Trade& t) {
    if (g_trade_count < kMaxTrades)
      g_trades[g_trade_count++] = TradeOut{static_cast<std::uint32_t>(t.maker), static_cast<std::uint32_t>(t.taker),
                                           t.price, t.qty, static_cast<std::uint32_t>(side), 0};
  });
  return static_cast<int>(r);
}

EMSCRIPTEN_KEEPALIVE int lob_cancel(std::uint32_t id) { return g_book->cancel(id) ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE int lob_best_bid() { return g_book->best_bid().value_or(-1); }
EMSCRIPTEN_KEEPALIVE int lob_best_ask() { return g_book->best_ask().value_or(-1); }
EMSCRIPTEN_KEEPALIVE int lob_order_count() { return static_cast<int>(g_book->order_count()); }

EMSCRIPTEN_KEEPALIVE TradeOut* lob_trades() { return g_trades; }
EMSCRIPTEN_KEEPALIVE int lob_trade_count() { return g_trade_count; }
EMSCRIPTEN_KEEPALIVE void lob_clear_trades() { g_trade_count = 0; }

// Fills the depth buffer for one side, best level first. Returns levels written.
EMSCRIPTEN_KEEPALIVE int lob_depth(int side, int max_levels) {
  if (max_levels > kMaxDepth) max_levels = kMaxDepth;
  int n = 0;
  std::int32_t* out = g_depth[side];
  g_book->for_each_level(side == 0 ? Side::Buy : Side::Sell, [&](Price p, Qty q, std::uint32_t c) {
    if (n < max_levels) {
      out[n * 3] = p;
      out[n * 3 + 1] = static_cast<std::int32_t>(q);
      out[n * 3 + 2] = static_cast<std::int32_t>(c);
      ++n;
    }
  });
  return n;
}
EMSCRIPTEN_KEEPALIVE std::int32_t* lob_depth_ptr(int side) { return g_depth[side]; }

// Top levels with their actual queues, front of the queue first. Per level:
// price, total, count, k, then k pairs of (id, qty). Returns levels written.
constexpr int kLadderLevels = 12, kLadderOrders = 40;
std::uint32_t g_ladder[2][kLadderLevels * (4 + 2 * kLadderOrders)];
EMSCRIPTEN_KEEPALIVE int lob_ladder(int side, int max_levels) {
  if (max_levels > kLadderLevels) max_levels = kLadderLevels;
  const Side s = side == 0 ? Side::Buy : Side::Sell;
  std::uint32_t* out = g_ladder[side];
  int n = 0;
  std::size_t w = 0;
  g_book->for_each_level(s, [&](Price p, Qty q, std::uint32_t c) {
    if (n >= max_levels) return;
    out[w++] = static_cast<std::uint32_t>(p);
    out[w++] = q;
    out[w++] = c;
    const std::size_t kpos = w++;
    std::uint32_t k = 0;
    g_book->for_each_order(s, p, [&](OrderId id, Qty oq) {
      if (k < kLadderOrders) {
        out[w++] = static_cast<std::uint32_t>(id);
        out[w++] = oq;
        ++k;
      }
    });
    out[kpos] = k;
    ++n;
  });
  return n;
}
EMSCRIPTEN_KEEPALIVE std::uint32_t* lob_ladder_ptr(int side) { return g_ladder[side]; }

// Replays the same synthetic flow through OrderBook and the std::map
// ReferenceBook inside the browser. Results: [fast ms, ref ms, fast traded,
// ref traded, fast resting, ref resting, ops].
EMSCRIPTEN_KEEPALIVE double* lob_bench(int n, int seed) {
  BookConfig cfg;
  cfg.min_price = 0;
  cfg.max_price = 65535;
  cfg.max_orders = 1u << 18;
  const auto flow = bench::make_order_flow(static_cast<std::size_t>(n), static_cast<std::uint64_t>(seed), cfg);

  auto run = [&](auto& book, double& ms, double& traded, double& resting) {
    std::uint64_t t = 0;
    auto on_trade = [&t](const Trade& x) { t += x.qty; };
    const double t0 = emscripten_get_now();
    for (const auto& op : flow) {
      if (op.kind == bench::Op::Add) book.add_limit(op.id, op.side, op.price, op.qty, on_trade);
      else book.cancel(op.id);
    }
    ms = emscripten_get_now() - t0;
    traded = static_cast<double>(t);
    resting = static_cast<double>(book.order_count());
  };
  {
    auto fast = std::make_unique<OrderBook>(cfg);
    run(*fast, g_bench[0], g_bench[2], g_bench[4]);
  }
  {
    auto ref = std::make_unique<ReferenceBook>(cfg);
    run(*ref, g_bench[1], g_bench[3], g_bench[5]);
  }
  g_bench[6] = n;
  return g_bench;
}

}  // extern "C"
