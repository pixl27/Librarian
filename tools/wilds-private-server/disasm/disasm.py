import capstone, sys
G="E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/"
IMGBASE=0x140000000
SEC={"data":0x1000,"sdata":0xd16b000,"rodata":0x155ed000,"udata":0x15740000,"srdata":0x2028e000}
buf={}
for n in SEC:
    try: buf[n]=open(G+"librarian_dump_"+n+".bin","rb").read()
    except FileNotFoundError: pass
def sec_of(rva):
    for n,base in SEC.items():
        if n in buf and base<=rva<base+len(buf[n]): return n,base
    return None,None
def strAt(rva):
    n,base=sec_of(rva)
    if not n: return None
    b=buf[n]; o=rva-base; e=o
    while e<len(b) and e-o<64 and b[e]!=0 and 0x20<=b[e]<=0x7e: e+=1
    if e>o and (e>=len(b) or b[e]==0): return b[o:e].decode("latin1",'replace')
    return None
def dis(rva_start,rva_end):
    n,base=sec_of(rva_start)
    if not n: print("no section for 0x%x (dump missing?)"%rva_start); return
    code=buf[n]; off=rva_start-base; length=rva_end-rva_start
    md=capstone.Cs(capstone.CS_ARCH_X86,capstone.CS_MODE_64); md.detail=True
    for insn in md.disasm(code[off:off+length],IMGBASE+rva_start):
        note=""
        for op in insn.operands:
            if op.type==capstone.x86.X86_OP_MEM and op.mem.base==capstone.x86.X86_REG_RIP:
                tgt=insn.address+insn.size+op.mem.disp; rva=tgt-IMGBASE
                s=strAt(rva); note=' ; "%s"'%s if s is not None else ' ; ->0x%x'%rva
        print("0x%08x: %-8s %s%s"%(insn.address-IMGBASE, insn.mnemonic, insn.op_str, note))
dis(int(sys.argv[1],16),int(sys.argv[2],16))
