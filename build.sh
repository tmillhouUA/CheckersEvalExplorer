#!/usr/bin/env bash
set -e

emcc src/cpp/engine.cpp \
  -O3 \
  --no-entry \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_play_game","_dbg_term_reason","_dbg_plies","_dbg_red_count","_dbg_black_count","_dbg_ef1_move_ms","_dbg_ef2_move_ms","_dbg_ef1_move_n","_dbg_ef2_move_n","_ig_reset","_ig_pick","_ig_cell","_ig_side","_ig_status","_ig_mover","_ig_promoted","_ig_path_len","_ig_path_sq","_ig_cap_len","_ig_cap_sq","_ig_eval","_ig_gen","_ig_gen_count","_ig_gen_from","_ig_gen_to","_ig_gen_path_len","_ig_gen_path_sq","_ig_gen_cap_len","_ig_gen_cap_sq","_ig_apply"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s ENVIRONMENT='web,worker' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='EngineModule' \
  -o engine.js

echo "Build complete. Serve this directory and refresh index.html."
