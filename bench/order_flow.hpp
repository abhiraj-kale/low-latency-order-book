#pragma once

#include <cstdint>
#include <random>
#include <vector>

#include "lob/types.hpp"

namespace lob::bench {

struct Op {
  enum Kind : std::uint8_t { Add, Cancel } kind;
  Side side;
  Price price;
  Qty qty;
  OrderId id;
};

// Synthetic but market-shaped order flow, generated up front so generation
// cost never lands inside a timed region.
//   - Mid price does a slow random walk.
//   - ~45% cancels of previously submitted orders (some already filled, which
//     exercises the "unknown id" path), ~45% passive adds clustered near the
//     touch, ~10% aggressive adds that cross the spread and trade.
inline std::vector<Op> make_order_flow(std::size_t n, std::uint64_t seed, const BookConfig& cfg) {
  std::mt19937_64 rng(seed);
  std::uniform_int_distribution<int> pct(0, 99);
  std::uniform_int_distribution<int> coin(0, 1);
  std::geometric_distribution<int> passive_offset(0.25);  // most orders within a few ticks of mid
  std::uniform_int_distribution<int> aggressive_offset(0, 3);
  std::uniform_int_distribution<Qty> small_qty(1, 100);

  const Price lo = cfg.min_price + 64;
  const Price hi = cfg.max_price - 64;
  Price mid = cfg.min_price + (cfg.max_price - cfg.min_price) / 2;

  std::vector<Op> ops;
  ops.reserve(n);
  std::vector<OrderId> submitted;
  submitted.reserve(n);
  OrderId next_id = 1;

  for (std::size_t i = 0; i < n; ++i) {
    if ((i & 63) == 0) {
      mid += coin(rng) ? 1 : -1;
      if (mid < lo) mid = lo;
      if (mid > hi) mid = hi;
    }
    const int r = pct(rng);
    if (r < 45 && !submitted.empty()) {
      std::uniform_int_distribution<std::size_t> pick(0, submitted.size() - 1);
      const std::size_t k = pick(rng);
      ops.push_back(Op{Op::Cancel, Side::Buy, 0, 0, submitted[k]});
      submitted[k] = submitted.back();
      submitted.pop_back();
      continue;
    }
    const Side side = coin(rng) ? Side::Buy : Side::Sell;
    const int dir = (side == Side::Buy) ? -1 : 1;  // passive side of the mid
    Price px;
    if (r >= 90) {
      px = mid - dir * aggressive_offset(rng);  // crosses the spread
    } else {
      px = mid + dir * (1 + passive_offset(rng));
    }
    if (px < cfg.min_price) px = cfg.min_price;
    if (px > cfg.max_price) px = cfg.max_price;
    const OrderId id = next_id++;
    ops.push_back(Op{Op::Add, side, px, small_qty(rng), id});
    submitted.push_back(id);
  }
  return ops;
}

}  // namespace lob::bench
