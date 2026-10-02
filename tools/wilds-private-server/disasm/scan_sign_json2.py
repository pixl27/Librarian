import mmap, re, sys

DUMPS = {
    "data":   ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_data.bin",   0x1000),
    "sdata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_sdata.bin",  0xd16b000),
    "rodata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_rodata.bin", 0x155ed000),
    "srdata": ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_srdata.bin", 0x2028e000),
    "udata":  ("E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_udata.bin",  0x15740000),
}

# JSON-shaped: token wrapped in double quotes. Then verify a colon appears close after.
KEYS = [b'rebe_token', b'gcp_token', b'next_token', b'nsa_id_token',
        b'result_code', b'expired_at', b'expires_at', b'access_token',
        b'id_token', b'session_token', b'error_code', b'linked', b'nsa_id']

def ctx(buf, pos, before, after):
    s = max(0, pos-before); e = min(len(buf), pos+after)
    return buf[s:e].decode('latin1')

for name,(path,base) in DUMPS.items():
    with open(path,'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        data = mm[:]  # note big; but we regex over mm directly
        for key in KEYS:
            # quoted form:  "key"
            pat = b'"' + key + b'"'
            for m in re.finditer(re.escape(pat), mm):
                pos = m.start()
                window = mm[pos:pos+len(pat)+8]
                # is there a colon right after the closing quote (allowing spaces)?
                tail = mm[pos+len(pat):pos+len(pat)+4]
                if b':' in tail:
                    snip = ctx(mm,pos,120,220).replace('\x00','.')
                    print(f"### JSON-ish {name} key={key.decode()} off=0x{pos:x} rva=0x{base+pos:x}")
                    print(f"    {snip!r}")
        mm.close()
print("DONE")
