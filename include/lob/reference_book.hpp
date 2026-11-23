#pragma once

#include <functional>
#include <iterator>
#include <list>
#include <map>
#include <optional>
#include <unordered_map>

#include "lob/types.hpp"

namespace lob {

// Straightforward node-based order book: std::map of price -> std::list FIFO,
// plus an unordered_map index. Same interface and semantics as OrderBook.
// Used as (1) the correctness oracle in differential tests and (2) the
// baseline in benchmarks. Every add/cancel touches several heap nodes.
class ReferenceBook {
 public:
  explicit ReferenceBook(const BookConfig& cfg) : cfg_(cfg) {}

  template <class OnTrade>
  AddResult add_limit(OrderId id, Side side, Price price, Qty qty, OnTrade&& on_trade) {
    if (qty == 0 || id == kInvalidId || price < cfg_.min_price || price > cfg_.max_price) return AddResult::Rejected;
    if (index_.size() >= cfg_.max_orders || index_.count(id)) return AddResult::Rejected;

    if (side == Side::Buy) {
      qty = match(asks_, id, qty, on_trade, [price](Price p) { return p <= price; });
      if (qty == 0) return AddResult::Filled;
      rest(bids_, Side::Buy, id, price, qty);
    } else {
      qty = match(bids_, id, qty, on_trade, [price](Price p) { return p >= price; });
      if (qty == 0) return AddResult::Filled;
      rest(asks_, Side::Sell, id, price, qty);
    }
    return AddResult::Rested;
  }

  bool cancel(OrderId id) {
    const auto it = index_.find(id);
    if (it == index_.end()) return false;
    const Loc loc = it->second;
    if (loc.side == Side::Buy) erase_order(bids_, loc); else erase_order(asks_, loc);
    index_.erase(it);
    return true;
  }

  std::optional<Price> best_bid() const {
    if (bids_.empty()) return std::nullopt;
    return bids_.begin()->first;
  }
  std::optional<Price> best_ask() const {
    if (asks_.empty()) return std::nullopt;
    return asks_.begin()->first;
  }
  std::size_t order_count() const { return index_.size(); }

  template <class F>
  void for_each_level(Side side, F&& f) const {
    auto visit = [&](const auto& book) {
      for (const auto& [px, q] : book) {
        Qty total = 0;
        for (const auto& o : q) total += o.qty;
        f(px, total, static_cast<std::uint32_t>(q.size()));
      }
    };
    if (side == Side::Buy) visit(bids_); else visit(asks_);
  }

 private:
  struct Node {
    OrderId id;
    Qty qty;
  };
  using Fifo = std::list<Node>;
  struct Loc {
    Side side;
    Price price;
    Fifo::iterator it;
  };

  template <class Book, class OnTrade, class Crosses>
  Qty match(Book& book, OrderId taker, Qty qty, OnTrade& on_trade, Crosses crosses) {
    while (qty > 0 && !book.empty() && crosses(book.begin()->first)) {
      auto level = book.begin();
      Fifo& q = level->second;
      while (qty > 0 && !q.empty()) {
        Node& m = q.front();
        const Qty fill = m.qty < qty ? m.qty : qty;
        on_trade(Trade{m.id, taker, level->first, fill});
        m.qty -= fill;
        qty -= fill;
        if (m.qty == 0) {
          index_.erase(m.id);
          q.pop_front();
        }
      }
      if (q.empty()) book.erase(level);
    }
    return qty;
  }

  template <class Book>
  void rest(Book& book, Side side, OrderId id, Price price, Qty qty) {
    Fifo& q = book[price];
    q.push_back(Node{id, qty});
    index_.emplace(id, Loc{side, price, std::prev(q.end())});
  }

  template <class Book>
  void erase_order(Book& book, const Loc& loc) {
    auto level = book.find(loc.price);
    level->second.erase(loc.it);
    if (level->second.empty()) book.erase(level);
  }

  BookConfig cfg_;
  std::map<Price, Fifo, std::greater<Price>> bids_;  // best (highest) first
  std::map<Price, Fifo> asks_;                       // best (lowest) first
  std::unordered_map<OrderId, Loc> index_;
};

}  // namespace lob
