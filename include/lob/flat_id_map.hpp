#pragma once

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <vector>

#include "lob/types.hpp"

namespace lob {

// Open-addressing hash map from OrderId to a 32-bit pool index.
//
// - Linear probing over flat arrays: a lookup is usually one or two cache lines.
// - Capacity is a power of two sized for a load factor <= 0.5, fixed at construction.
// - Deletion uses backward-shift (no tombstones), so probe chains never degrade.
// - Fibonacci hashing spreads sequential exchange ids across the table.
class FlatIdMap {
 public:
  explicit FlatIdMap(std::uint32_t max_entries)
      : max_size_(max_entries),
        capacity_(std::bit_ceil(std::max<std::size_t>(2 * static_cast<std::size_t>(max_entries), 16))),
        mask_(capacity_ - 1),
        shift_(64 - std::countr_zero(capacity_)),
        keys_(capacity_, kInvalidId),
        vals_(capacity_, kNull) {}

  // Returns false if the key is invalid, already present, or the map is full.
  bool insert(OrderId key, std::uint32_t value) noexcept {
    if (key == kInvalidId || size_ >= max_size_) return false;
    std::size_t i = home(key);
    while (keys_[i] != kInvalidId) {
      if (keys_[i] == key) return false;
      i = (i + 1) & mask_;
    }
    keys_[i] = key;
    vals_[i] = value;
    ++size_;
    return true;
  }

  // Returns kNull if absent.
  std::uint32_t find(OrderId key) const noexcept {
    std::size_t i = home(key);
    while (keys_[i] != kInvalidId) {
      if (keys_[i] == key) return vals_[i];
      i = (i + 1) & mask_;
    }
    return kNull;
  }

  bool erase(OrderId key) noexcept {
    std::size_t i = home(key);
    while (keys_[i] != key) {
      if (keys_[i] == kInvalidId) return false;
      i = (i + 1) & mask_;
    }
    // Backward-shift: pull later entries of the probe chain into the hole if
    // their home slot is not in the cyclic range (hole, j].
    std::size_t j = i;
    for (;;) {
      j = (j + 1) & mask_;
      if (keys_[j] == kInvalidId) break;
      const std::size_t k = home(keys_[j]);
      const bool k_in_range = (i <= j) ? (i < k && k <= j) : (i < k || k <= j);
      if (k_in_range) continue;
      keys_[i] = keys_[j];
      vals_[i] = vals_[j];
      i = j;
    }
    keys_[i] = kInvalidId;
    --size_;
    return true;
  }

  std::size_t size() const noexcept { return size_; }

 private:
  std::size_t home(OrderId key) const noexcept {
    return static_cast<std::size_t>((key * 0x9E3779B97F4A7C15ull) >> shift_);
  }

  std::size_t max_size_;
  std::size_t capacity_;
  std::size_t mask_;
  int shift_;
  std::size_t size_ = 0;
  std::vector<OrderId> keys_;
  std::vector<std::uint32_t> vals_;
};

}  // namespace lob
