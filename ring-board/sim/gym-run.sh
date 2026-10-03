#!/usr/bin/env bash
# Long gym test (all cores, low priority): old movement vs old + finals brain, same seeds.
# Uso: bash sim/gym-run.sh   -> sim/results/gym-<date>.txt
cd "$(dirname "$0")/.."
OUT="sim/results/gym-$(date +%Y%m%d-%H%M).txt"
{
  echo "== Finals 1v1, rival = finals model (2000 each) =="
  node sim/ring-sim.mjs --final --rounds 2000 --brain both
  echo "== Finals 1v1, rival = general model (2000 each) =="
  node sim/ring-sim.mjs --final --rounds 2000 --brain both --rival-model general
  echo "== Full rounds, 7 rivals (1000 each): old vs old + finals brain =="
  node sim/ring-sim.mjs --rounds 1000 --rivals 7 --brain old
  node sim/ring-sim.mjs --rounds 1000 --rivals 7 --brain finals
} > "$OUT" 2>&1
echo "done -> $OUT"
