cmake_minimum_required(VERSION 3.20)
project(low_latency_order_book LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

find_package(Threads REQUIRED)

add_library(lob INTERFACE)
target_include_directories(lob INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(lob INTERFACE Threads::Threads)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(lob INTERFACE -Wall -Wextra -Wpedantic $<$<CONFIG:Release>:-O3 -march=native>)
endif()

add_executable(lob_tests tests/test_main.cpp)
target_include_directories(lob_tests PRIVATE bench)
target_link_libraries(lob_tests PRIVATE lob)

add_executable(bench_latency bench/bench_latency.cpp)
target_link_libraries(bench_latency PRIVATE lob)

add_executable(bench_pipeline bench/bench_pipeline.cpp)
target_link_libraries(bench_pipeline PRIVATE lob)

if(MINGW)
  # Self-contained binaries on Windows (no MSYS2 runtime DLLs needed).
  foreach(t lob_tests bench_latency bench_pipeline)
    target_link_options(${t} PRIVATE -static)
  endforeach()
endif()

enable_testing()
add_test(NAME lob_tests COMMAND lob_tests)
