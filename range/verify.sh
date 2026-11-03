#!/bin/bash
# Independent re-check: run the submitted exploit and compare against the exact
# expected flag (not just the pattern).
#   verify.sh <id> <phase> <expected-flag>
set -u
id=${1:?}
phase=${2:?}
expected=${3:?}
port=$(awk -v i="$id" '$1==i{print $2}' "$HOME/pwnrange/ports.txt")
dir="$HOME/pwnrange/solves/$phase/$id"
if [ ! -f "$dir/exploit.py" ]; then
  echo "MISSING $id $phase (no exploit.py)"
  exit 2
fi
cd "$dir" || exit 2
timeout 40 python3 exploit.py 127.0.0.1 "$port" > verify.txt 2>&1
rc=$?
if grep -qF "$expected" verify.txt; then
  echo "PASS $id $phase rc=$rc"
else
  echo "FAIL $id $phase rc=$rc"
  tail -c 600 verify.txt | sed 's/^/    /'
fi
