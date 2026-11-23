#pragma once

#include <cstdint>
#include <vector>

#include "lob/types.hpp"

namespace lob {

// Fixed-capacity pool of T addressed by 32-bit index. All memory is allocated
// up front, so allocate() and release() never touch the heap.
//
// Free slots are kept on a LIFO stack: the slot released most recently is the
// next one handed out, which keeps hot memory in cache.
template <class T>
class ObjectPool {
 public:
  explicit ObjectPool(std::uint32_t capacity)
      : slots_(capacity), free_(capacity), top_(capacity) {
    // Pop order 0, 1, 2, ... so a fresh pool fills memory front to back.
    for (std::uint32_t i = 0; i < capacity; ++i) free_[i] = capacity - 1 - i;
  }

  std::uint32_t allocate() noexcept { return top_ == 0 ? kNull : free_[--top_]; }
  void release(std::uint32_t index) noexcept { free_[top_++] = index; }

  std::uint32_t available() const noexcept { return top_; }
  std::uint32_t capacity() const noexcept { return static_cast<std::uint32_t>(slots_.size()); }

  T& operator[](std::uint32_t index) noexcept { return slots_[index]; }
  const T& operator[](std::uint32_t index) const noexcept { return slots_[index]; }

 private:
  std::vector<T> slots_;
  std::vector<std::uint32_t> free_;
  std::uint32_t top_;
};

}  // namespace lob
