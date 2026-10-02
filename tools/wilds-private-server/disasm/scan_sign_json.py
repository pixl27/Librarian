import mmap, re, sys, os

DUMPS = {
    "data":   ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_data.bin",   0x1000),
    "sdata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_sdata.bin",  0xd16b000),
    "rodata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_rodata.bin", 0x155ed000),
    "srdata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_srdata.bin", 0x2028e000),
    "udata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_udata.bin",  0x15740000),
}

# search both quoted and unquoted forms
TOKENS = [
    b'rebe_token', b'gcp_token', b'next_token', b'nsa_id_token',
    b'result_code', b'expired_at', b'expires_at', b'access_token',
    b'id_token', b'session_token', b'error_code',
]

def ctx(buf, pos, before=100, after=180):
    s = max(0, pos-before)
    e = min(len(buf), pos+after)
    return buf[s:e].decode('latin1')

for name,(path,base) in DUMPS.items():
    with open(path,'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        for tok in TOKENS:
            hits = [m.start() for m in re.finditer(re.escape(tok), mm)]
            if hits:
                print(f"### {name} token={tok.decode()} count={len(hits)}")
                for pos in hits[:6]:
                    snip = ctx(mm,pos).replace('\x00','.')
                    print(f"  off=0x{pos:x} rva=0x{base+pos:x} :: {snip!r}")
        mm.close()
