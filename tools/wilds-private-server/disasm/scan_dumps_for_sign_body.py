import re
import os
import mmap
import sys

dumps = [
    r"E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_data.bin",
    r"E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_sdata.bin",
    r"E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_rodata.bin",
    r"E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_srdata.bin",
    r"E:/Games/steam/steamapps/common/Monster_Hunter_Wilds/librarian_dump_udata.bin",
]

section_rva = {
    "librarian_dump_data.bin": 0x1000,
    "librarian_dump_sdata.bin": 0xd16b000,
    "librarian_dump_rodata.bin": 0x155ed000,
    "librarian_dump_udata.bin": 0x15740000,
    "librarian_dump_srdata.bin": 0x2028e000,
}

patterns = [
    b'"rebe_token"',
    b'"gcp_token"',
    b'"next_token"',
    b'"nsa_id_token"',
    b'"result_code"',
    b'"expired_at"',
    b'result_code',
    b'expired_at',
    b'"sub"',
    b'"iat"',
    b'"exp"',
    b'"linked"',
    b'"cc"',
    b'"lat"',
    b'"lng"',
    b'RebeErrorCause',
    b'JsonFormat',
    b'MtmSign',
    b'HttpMtmSign',
    b'steam-steam/sign',
    b'eyJ',
]

def printable_ratio(b: bytes) -> float:
    if not b:
        return 0.0
    printable = sum(1 for c in b if 32 <= c < 127 or c in (9, 10, 13))
    return printable / len(b)

def is_json_instance(ctx: bytes) -> bool:
    # crude heuristic: contains a colon followed eventually by a quote or brace/bracket/digit,
    # and at least one '{' - distinguishes real JSON object instances from
    # contiguous type-name string tables (dotted names with no punctuation).
    return b':' in ctx and (b'{' in ctx or b'"' in ctx)

total_hits = 0
for path in dumps:
    base = os.path.basename(path)
    if not os.path.exists(path):
        print(f"MISSING: {path}")
        continue
    size = os.path.getsize(path)
    print(f"=== {base} ({size} bytes) rva_base=0x{section_rva.get(base,0):x} ===")
    with open(path, 'rb') as f:
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            MAX_PER_PAT = 40
            for pat in patterns:
                start_search = 0
                count_this_pat = 0
                skipped = 0
                while count_this_pat < MAX_PER_PAT:
                    idx = mm.find(pat, start_search)
                    if idx == -1:
                        break
                    ctx_start = max(0, idx - 120)
                    ctx_end = min(size, idx + len(pat) + 200)
                    ctx = mm[ctx_start:ctx_end]
                    if len(pat) <= 4 and printable_ratio(ctx) < 0.85:
                        # short/noisy pattern (e.g. "eyJ") hit inside binary noise, skip
                        skipped += 1
                        start_search = idx + 1
                        continue
                    count_this_pat += 1
                    total_hits += 1
                    dec = ctx.decode('latin1').replace('\n', '\\n').replace('\r', '\\r')
                    json_like = is_json_instance(ctx)
                    rva = section_rva.get(base, 0) + idx
                    print(f"  [{pat.decode()}] file_offset={idx} (0x{idx:x}) rva=0x{rva:x} json_like={json_like}")
                    print(f"    ctx: {dec}")
                    start_search = idx + 1
                if skipped:
                    print(f"  [{pat.decode()}] skipped {skipped} noisy/binary hits")
        finally:
            mm.close()
    print()

print(f"TOTAL HITS: {total_hits}")
