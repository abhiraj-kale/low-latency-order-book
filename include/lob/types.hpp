#pragma once

#include <cstdint>

namespace lob {

using OrderId = std::uint64_t;
using Price = std::int32_t;  // integer ticks
using Qty = std::uint32_t;

enum class Side : std::uint8_t { Buy = 0, Sell = 1 };

// One execution between a resting (maker) order and an incoming (taker) order.
// Trades always print at the maker's price.
struct Trade {
  OrderId maker;
  OrderId taker;
  Price price;
  Qty qty;

  friend bool operator==(const Trade&, const Trade&) = default;
};

enum class AddResult : std::uint8_t { Rested, Filled, Rejected };

inline constexpr std::uint32_t kNull = 0xFFFFFFFFu;  // null index for pools and lists
inline constexpr OrderId kInvalidId = ~OrderId{0};   // reserved, never a valid order id

struct BookConfig {
  Price min_price = 0;
  Price max_price = 65535;
  std::uint32_t max_orders = 1u << 20;  // max resting orders at any time
};

}  // namespace lob
