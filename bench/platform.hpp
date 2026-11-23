#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <pthread.h>
#include <sched.h>
#endif

#include <x86intrin.h>

namespace lob::bench {

// Pins the calling thread to one logical CPU so the scheduler cannot migrate it
// mid-measurement.
inline bool pin_thread(int cpu) {
#if defined(_WIN32)
  return SetThreadAffinityMask(GetCurrentThread(), DWORD_PTR{1} << cpu) != 0;
#else
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(cpu, &set);
  return pthread_setaffinity_np(pthread_self(), sizeof(set), &set) == 0;
#endif
}

// Serialized TSC reads: lfence keeps the measured code from being reordered
// across the timestamp. rdtscp waits for prior instructions to retire.
inline std::uint64_t tsc_begin() {
  _mm_lfence();
  const std::uint64_t t = __rdtsc();
  _mm_lfence();
  return t;
}
inline std::uint64_t tsc_end() {
  unsigned aux;
  const std::uint64_t t = __rdtscp(&aux);
  _mm_lfence();
  return t;
}
inline std::uint64_t tsc_now() { return __rdtsc(); }

// TSC ticks per nanosecond, measured against steady_clock over ~200 ms.
inline double calibrate_tsc_per_ns() {
  using clock = std::chrono::steady_clock;
  const auto c0 = clock::now();
  const std::uint64_t t0 = tsc_begin();
  while (clock::now() - c0 < std::chrono::milliseconds(200)) {
  }
  const std::uint64_t t1 = tsc_end();
  const auto c1 = clock::now();
  const double ns = std::chrono::duration<double, std::nano>(c1 - c0).count();
  return static_cast<double>(t1 - t0) / ns;
}

// Median cost of an empty begin/end pair, subtracted from every sample.
inline std::uint64_t measure_tsc_overhead() {
  std::vector<std::uint64_t> s(100000);
  for (auto& x : s) {
    const std::uint64_t a = tsc_begin();
    const std::uint64_t b = tsc_end();
    x = b - a;
  }
  std::nth_element(s.begin(), s.begin() + s.size() / 2, s.end());
  return s[s.size() / 2];
}

struct Percentiles {
  double p50, p90, p99, p999, max;
};

// samples are in TSC ticks; result is in nanoseconds.
inline Percentiles percentiles_ns(std::vector<std::uint64_t> samples, double tsc_per_ns) {
  if (samples.empty()) return {0, 0, 0, 0, 0};
  std::sort(samples.begin(), samples.end());
  auto at = [&](double q) {
    const std::size_t i = static_cast<std::size_t>(q * static_cast<double>(samples.size() - 1));
    return static_cast<double>(samples[i]) / tsc_per_ns;
  };
  return {at(0.50), at(0.90), at(0.99), at(0.999), static_cast<double>(samples.back()) / tsc_per_ns};
}

inline void print_row(const char* name, const Percentiles& p) {
  std::printf("  %-26s p50 %7.0f ns | p90 %7.0f ns | p99 %7.0f ns | p99.9 %8.0f ns | max %9.0f ns\n", name, p.p50,
              p.p90, p.p99, p.p999, p.max);
}

}  // namespace lob::bench
