import mmap, re

DUMPS = {
    "data":   ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_data.bin",   0x1000),
    "sdata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_sdata.bin",  0xd16b000),
    "rodata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_rodata.bin", 0x155ed000),
    "srdata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_srdata.bin", 0x2028e000),
    "udata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_udata.bin",  0x15740000),
}

def ctx(buf, pos, before, after):
    s = max(0, pos-before); e = min(len(buf), pos+after)
    return buf[s:e].decode('latin1')

# 1) quoted keys regardless of trailing char
KEYS = [b'rebe_token', b'gcp_token', b'next_token', b'nsa_id_token',
        b'result_code', b'expired_at', b'expires_at', b'nsa_id', b'linked']

for name,(path,base) in DUMPS.items():
    with open(path,'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        for key in KEYS:
            pat = b'"' + key + b'"'
            hits = [m.start() for m in re.finditer(re.escape(pat), mm)]
            for pos in hits[:8]:
                snip = ctx(mm,pos,100,160).replace('\x00','.')
                print(f"[QKEY] {name} {key.decode()} off=0x{pos:x} rva=0x{base+pos:x} :: {snip!r}")
        # 2) JWT header base64url:  eyJ  (== {" base64url).  JWTs start eyJ
        for m in re.finditer(rb'eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}', mm):
            pos = m.start()
            snip = ctx(mm,pos,20,180).replace('\x00','.')
            print(f"[JWT] {name} off=0x{pos:x} rva=0x{base+pos:x} :: {snip!r}")
        # 3) generic JSON object openings that mention token
        for m in re.finditer(rb'\{\s*"[A-Za-z_]{2,20}"\s*:', mm):
            pos = m.start()
            snip = mm[pos:pos+120]
            if b'token' in snip.lower() or b'result' in snip.lower() or b'expire' in snip.lower():
                print(f"[OBJ] {name} off=0x{pos:x} rva=0x{base+pos:x} :: {ctx(mm,pos,10,150).replace(chr(0),'.')!r}")
        mm.close()
print("DONE")
