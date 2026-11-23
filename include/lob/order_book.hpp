#pragma once

#include <bit>
#include <cstdint>
#include <optional>
#include <vector>

#include "lob/flat_id_map.hpp"
#include "lob/object_pool.hpp"
#include "lob/types.hpp"

namespace lob {

// Single-instrument limit order book with price-time priority matching.
//
// Layout (everything preallocated at construction, nothing allocates on the hot path):
//   - Price ladder: one flat array of Level per side, indexed by (price - min_price).
//     Lookup of a price level is a single array index, no tree walk.
//   - Occupancy bitset per side: bit i is set when level i has resting orders.
//     Finding the next best price after a level empties scans 64 levels per
//     word with countr_zero / countl_zero.
//   - Orders live in an ObjectPool and are linked into an intrusive doubly linked
//     FIFO per level using 32-bit indices (no pointers, 32-byte nodes).
//   - FlatIdMap maps OrderId -> pool index for O(1) cancel.
//
// Complexity: add (resting) O(1), cancel O(1) amortized, match O(fills + levels crossed).
class OrderBook {
 public:
  explicit OrderBook(const BookConfig& cfg)
      : min_price_(cfg.min_price),
        num_levels_(static_cast<std::int32_t>(cfg.max_price - cfg.min_price + 1)),
        pool_(cfg.max_orders),
        ids_(cfg.max_orders) {
    for (auto& side : levels_) side.assign(static_cast<std::size_t>(num_levels_), Level{});
    for (auto& bits : occupied_) bits.assign(static_cast<std::size_t>((num_levels_ + 63) / 64), 0);
  }

  // Adds a limit order. Crosses the opposite side first, emitting one Trade per
  // fill through on_trade (inlined: pass a lambda), then rests any remainder.
  template <class OnTrade>
  AddResult add_limit(OrderId id, Side side, Price price, Qty qty, OnTrade&& on_trade) {
    if (qty == 0 || id == kInvalidId || price < min_price_ || price > max_price()) return AddResult::Rejected;
    if (pool_.available() == 0 || ids_.find(id) != kNull) return AddResult::Rejected;

    const std::int32_t idx = price - min_price_;
    qty = (side == Side::Buy) ? match<Side::Sell>(id, idx, qty, on_trade)
                              : match<Side::Buy>(id, idx, qty, on_trade);
    if (qty == 0) return AddResult::Filled;

    const std::uint32_t slot = pool_.allocate();  // guaranteed by the check above
    pool_[slot] = Order{id, price, qty, side, kNull, kNull};
    const int s = static_cast<int>(side);
    Level& lvl = levels_[s][idx];
    link_tail(lvl, slot);
    lvl.total += qty;
    if (++lvl.count == 1) {
      set_bit(s, idx);
      if (side == Side::Buy) {
        if (idx > best_bid_) best_bid_ = idx;
      } else if (best_ask_ == kNone || idx < best_ask_) {
        best_ask_ = idx;
      }
    }
    ids_.insert(id, slot);
    return AddResult::Rested;
  }

  // Removes a resting order. Returns false if the id is unknown or already filled.
  bool cancel(OrderId id) {
    const std::uint32_t slot = ids_.find(id);
    if (slot == kNull) return false;
    const Order& o = pool_[slot];
    const int s = static_cast<int>(o.side);
    const std::int32_t idx = o.price - min_price_;
    Level& lvl = levels_[s][idx];
    unlink(lvl, slot);
    lvl.total -= o.qty;
    if (--lvl.count == 0) {
      clear_bit(s, idx);
      if (o.side == Side::Buy) {
        if (best_bid_ == idx) best_bid_ = prev_set(s, idx - 1);
      } else if (best_ask_ == idx) {
        best_ask_ = next_set(s, idx + 1);
      }
    }
    ids_.erase(id);
    pool_.release(slot);
    return true;
  }

  std::optional<Price> best_bid() const {
    if (best_bid_ == kNone) return std::nullopt;
    return min_price_ + best_bid_;
  }
  std::optional<Price> best_ask() const {
    if (best_ask_ == kNone) return std::nullopt;
    return min_price_ + best_ask_;
  }

  Qty depth_at(Side side, Price price) const {
    if (price < min_price_ || price > max_price()) return 0;
    return levels_[static_cast<int>(side)][price - min_price_].total;
  }

  std::size_t order_count() const { return ids_.size(); }
  Price min_price() const { return min_price_; }
  Price max_price() const { return min_price_ + num_levels_ - 1; }

  // Visits non-empty levels from best to worst: f(price, total_qty, order_count).
  template <class F>
  void for_each_level(Side side, F&& f) const {
    const int s = static_cast<int>(side);
    if (side == Side::Buy) {
      for (std::int32_t i = best_bid_; i != kNone; i = prev_set(s, i - 1))
        f(min_price_ + i, levels_[s][i].total, levels_[s][i].count);
    } else {
      for (std::int32_t i = best_ask_; i != kNone; i = next_set(s, i + 1))
        f(min_price_ + i, levels_[s][i].total, levels_[s][i].count);
    }
  }

 private:
  struct Order {  // 32 bytes: two orders per cache line
    OrderId id;
    Price price;
    Qty qty;
    Side side;
    std::uint32_t prev;
    std::uint32_t next;
  };
  static_assert(sizeof(Order) == 32);

  struct Level {  // 16 bytes
    std::uint32_t head = kNull;
    std::uint32_t tail = kNull;
    Qty total = 0;
    std::uint32_t count = 0;
  };

  static constexpr std::int32_t kNone = -1;

  // Walks the opposite side from its best price while it crosses limit_idx.
  template <Side Maker, class OnTrade>
  Qty match(OrderId taker, std::int32_t limit_idx, Qty qty, OnTrade& on_trade) {
    constexpr int ms = static_cast<int>(Maker);
    std::int32_t& best = (Maker == Side::Sell) ? best_ask_ : best_bid_;
    while (qty > 0 && best != kNone && (Maker == Side::Sell ? best <= limit_idx : best >= limit_idx)) {
      Level& lvl = levels_[ms][best];
      const Price px = min_price_ + best;
      while (qty > 0 && lvl.head != kNull) {
        const std::uint32_t h = lvl.head;
        Order& m = pool_[h];
        const Qty fill = m.qty < qty ? m.qty : qty;
        on_trade(Trade{m.id, taker, px, fill});
        m.qty -= fill;
        lvl.total -= fill;
        qty -= fill;
        if (m.qty == 0) {
          unlink(lvl, h);
          --lvl.count;
          ids_.erase(m.id);
          pool_.release(h);
        }
      }
      if (lvl.head == kNull) {
        clear_bit(ms, best);
        best = (Maker == Side::Sell) ? next_set(ms, best + 1) : prev_set(ms, best - 1);
      }
    }
    return qty;
  }

  void link_tail(Level& l, std::uint32_t s) {
    Order& o = pool_[s];
    o.prev = l.tail;
    o.next = kNull;
    if (l.tail != kNull) pool_[l.tail].next = s; else l.head = s;
    l.tail = s;
  }

  void unlink(Level& l, std::uint32_t s) {
    const Order& o = pool_[s];
    if (o.prev != kNull) pool_[o.prev].next = o.next; else l.head = o.next;
    if (o.next != kNull) pool_[o.next].prev = o.prev; else l.tail = o.prev;
  }

  void set_bit(int s, std::int32_t i) { occupied_[s][i >> 6] |= (1ull << (i & 63)); }
  void clear_bit(int s, std::int32_t i) { occupied_[s][i >> 6] &= ~(1ull << (i & 63)); }

  // Lowest set bit at index >= from, or kNone.
  std::int32_t next_set(int s, std::int32_t from) const {
    if (from >= num_levels_) return kNone;
    const auto& w = occupied_[s];
    std::size_t wi = static_cast<std::size_t>(from) >> 6;
    std::uint64_t word = w[wi] & (~0ull << (from & 63));
    for (;;) {
      if (word) return static_cast<std::int32_t>((wi << 6) + std::countr_zero(word));
      if (++wi >= w.size()) return kNone;
      word = w[wi];
    }
  }

  // Highest set bit at index <= from, or kNone.
  std::int32_t prev_set(int s, std::int32_t from) const {
    if (from < 0) return kNone;
    const auto& w = occupied_[s];
    std::size_t wi = static_cast<std::size_t>(from) >> 6;
    const int bit = from & 63;
    std::uint64_t word = w[wi] & (bit == 63 ? ~0ull : ((1ull << (bit + 1)) - 1));
    for (;;) {
      if (word) return static_cast<std::int32_t>((wi << 6) + 63 - std::countl_zero(word));
      if (wi == 0) return kNone;
      word = w[--wi];
    }
  }

  Price min_price_;
  std::int32_t num_levels_;
  std::int32_t best_bid_ = kNone;
  std::int32_t best_ask_ = kNone;
  std::vector<Level> levels_[2];
  std::vector<std::uint64_t> occupied_[2];
  ObjectPool<Order> pool_;
  FlatIdMap ids_;
};

}  // namespace lob
