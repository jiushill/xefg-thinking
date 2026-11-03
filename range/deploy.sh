#!/bin/bash
# Start one container per challenge on 10001..10008 (host network).
# Each gets its own flag so a solve is verifiable and not forgeable.
#
# Runs as the normal user: sudo is driven through an askpass helper so the
# script can keep writing flags.txt into the user's home.
set -u
ASK=/tmp/.saskpass
printf '#!/bin/sh\necho "${VM_PASS:?set VM_PASS}"\n' > "$ASK"
chmod 700 "$ASK"
export SUDO_ASKPASS="$ASK"
SUDO="sudo -A"

IMG=xefg/range:1
SPECS="a1:/chals/a1/pwn a2:/chals/a2/pwn a3:/chals/a3/bypwn a4:/chals/a4/canary b1:/chals/b1/bin_79b89d7c b2:/chals/b2/bin_82cfdbe6 b3:/chals/b3/bin_ae3f24d3 b4:/chals/b4/bin_f5b5ad3d"

port=10001
: > "$HOME/pwnrange/flags.txt"
mkdir -p "$HOME/pwnrange/solves"
for some in $SPECS; do
  id=${some%%:*}
  bin=${some#*:}
  flag="XEFG{$id-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  $SUDO docker rm -f "xefg-$id" >/dev/null 2>&1
  $SUDO docker run -d --name "xefg-$id" --network host \
    -e PORT="$port" -e BIN="$bin" -e FLAG="$flag" "$IMG" >/dev/null
  printf '%s %s %s\n' "$id" "$port" "$flag" >> "$HOME/pwnrange/flags.txt"
  port=$((port + 1))
done
sleep 1
echo "=== containers ==="
$SUDO docker ps --filter name=xefg- --format '{{.Names}}  {{.Status}}'
echo "=== flags ==="
cat "$HOME/pwnrange/flags.txt"
echo "=== listening ==="
ss -ltn 2>/dev/null | awk '$4 ~ /:1000[1-8]$/ {print $4}' | sort
