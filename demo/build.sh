#!/usr/bin/env sh
# Builds demo/site/lob.js + lob.wasm from the C++ engine with Emscripten.
#   docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:3.1.74 sh demo/build.sh
set -e
em++ -std=c++20 -O3 -flto -fno-exceptions -Wall -Wextra \
  -Iinclude -Ibench demo/wasm/lob_wasm.cpp -o demo/site/lob.js \
  -sMODULARIZE=1 -sEXPORT_NAME=createLob -sENVIRONMENT=web \
  -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAP32,HEAPU32,HEAPF64 \
  -sFILESYSTEM=0 -sASSERTIONS=0
ls -l demo/site/lob.js demo/site/lob.wasm
