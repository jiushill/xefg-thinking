#!/bin/bash
# Run one solve script against its live service.
#   ~/pwnrange/run.sh <id> [phase]
# Every invocation appends to attempts.log, so "failed attempts before success"
# becomes measurable without trusting anyone's self-report.
set -u
id=${1:?usage: run.sh <id> [phase]}
phase=${2:-cur}
port=$(awk -v i="$id" '$1==i{print $2}' "$HOME/pwnrange/ports.txt")
dir="$HOME/pwnrange/solves/$phase/$id"
if [ ! -f "$dir/exploit.py" ]; then
  echo "no exploit at $dir/exploit.py"
  exit 2
fi
mkdir -p "$dir"
cd "$dir" || exit 2
echo "$(date +%s) start" >> attempts.log
timeout 40 python3 exploit.py 127.0.0.1 "$port" > out.txt 2>&1
rc=$?
hit=no
if grep -qE 'XEFG\{[a-z0-9]+-[0-9a-f]+\}' out.txt; then hit=yes; fi
echo "$(date +%s) rc=$rc flag=$hit" >> attempts.log
runs=$(grep -c start attempts.log)
echo "--- rc=$rc port=$port run#$runs flag=$hit"
tail -c 4000 out.txt
if [ "$hit" = "yes" ]; then
  echo "=== FLAG CAPTURED ==="
else
  echo "=== no flag ==="
fi
