#!/bin/bash
# stats.sh <phase> [<phase>...] — objective per-rep accounting for s1.
for ph in "$@"; do
  d="$HOME/pwnrange/solves/$ph/s1"
  if [ ! -d "$d" ]; then echo "$ph: no dir"; continue; fi
  runs=$(grep -c start "$d/attempts.log" 2>/dev/null || true)
  solved=$(grep -c "flag=yes" "$d/attempts.log" 2>/dev/null || true)
  first=$(head -1 "$d/attempts.log" 2>/dev/null | cut -d' ' -f1)
  hit=$(grep "flag=yes" "$d/attempts.log" 2>/dev/null | head -1 | cut -d' ' -f1)
  echo "$ph runs=${runs:-0} solved=${solved:-0} first=${first:-0} hit=${hit:-0}"
done
