#pragma once

#include <atomic>
#include <cstddef>

namespace lob {

inline constexpr std::size_t kCacheLine = 64;

// Bounded lock-free single-producer / single-consumer ring buffer.
//
// - Capacity is a power of two; indices grow monotonically and are masked.
// - The producer publishes with a release store on head_, the consumer
//   observes it with an acquire load (and vice versa for tail_), which is all
//   the ordering a single producer and single consumer need. No CAS, no locks.
// - Each side keeps a cached copy of the other side's index, so the shared
//   cache line is only read when the queue looks full (producer) or empty
//   (consumer). In steady state the two threads rarely touch the same line.
// - Producer-owned and consumer-owned fields live on separate cache lines to
//   avoid false sharing.
template <class T, std::size_t Capacity>
class SpscQueue {
  static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "Capacity must be a power of two");

 public:
  bool try_push(const T& value) noexcept {
    const std::size_t head = head_.load(std::memory_order_relaxed);
    if (head - tail_cache_ == Capacity) {
      tail_cache_ = tail_.load(std::memory_order_acquire);
      if (head - tail_cache_ == Capacity) return false;  // full
    }
    buffer_[head & kMask] = value;
    head_.store(head + 1, std::memory_order_release);
    return true;
  }

  bool try_pop(T& out) noexcept {
    const std::size_t tail = tail_.load(std::memory_order_relaxed);
    if (tail == head_cache_) {
      head_cache_ = head_.load(std::memory_order_acquire);
      if (tail == head_cache_) return false;  // empty
    }
    out = buffer_[tail & kMask];
    tail_.store(tail + 1, std::memory_order_release);
    return true;
  }

  static constexpr std::size_t capacity() noexcept { return Capacity; }

 private:
  static constexpr std::size_t kMask = Capacity - 1;

  // Producer-owned line.
  alignas(kCacheLine) std::atomic<std::size_t> head_{0};
  std::size_t tail_cache_ = 0;

  // Consumer-owned line.
  alignas(kCacheLine) std::atomic<std::size_t> tail_{0};
  std::size_t head_cache_ = 0;

  alignas(kCacheLine) T buffer_[Capacity];
};

}  // namespace lob
