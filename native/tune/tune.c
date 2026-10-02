/*
 * librarian_tune — the launch-time half of Tuning, as a small executable.
 *
 * Node cannot ask Windows about processor topology, cannot pin a process to a
 * set of cores and cannot change a display mode. Each of those is one Win32
 * call with a little bookkeeping around it, and the pattern in this tree for
 * that is a single-purpose program the launcher runs and reads JSON back from
 * (see winborder, inject). Same here.
 *
 *   librarian_tune topology
 *       Cores by efficiency class, L3 cache domains, and what to recommend:
 *       "pcores" on a hybrid part (the performance class), "vcache" on a
 *       two-die part whose dies carry different L3 sizes (the big one),
 *       "none" when the machine is uniform and pinning could only hurt.
 *
 *   librarian_tune affinity <pid> <auto|pcores|vcache|none|mask:HEX>
 *       Apply. CPU sets when Windows offers them (soft: the scheduler prefers
 *       these processors and may still spill under load, which is what a game
 *       wants); the hard affinity mask as a fallback. "none" clears the CPU
 *       sets this program set and leaves the hard mask alone.
 *
 *   librarian_tune affinity-get <pid>
 *       Read back: the hard mask and the default CPU set ids, so a caller can
 *       check that an apply took.
 *
 *   librarian_tune display query
 *   librarian_tune display max
 *   librarian_tune display set <hz>
 *       The primary display's current mode, the refresh rates available at
 *       that resolution, and a dynamic switch (no registry write) to the
 *       highest of them or back to a given one.
 *
 * Every command prints one JSON object. Exit 0 on success, 1 on usage, 2 when
 * Windows refused; the JSON carries "error" in that case.
 */
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { OK = 0, USAGE = 1, REFUSED = 2 };

/* ── Topology ─────────────────────────────────────────────────────*/
#define MAX_CORES 128
#define MAX_L3    16

typedef struct {
    unsigned  logical;                       /* logical processors in group 0 */
    unsigned  ncores;
    struct { BYTE efficiency; KAFFINITY mask; } core[MAX_CORES];
    unsigned  nl3;
    struct { DWORD size_kb; KAFFINITY mask; } l3[MAX_L3];
    BYTE      max_eff, min_eff;
    int       other_groups;                  /* processors beyond group 0 exist */
} topology_t;

static int read_topology(topology_t *t)
{
    memset(t, 0, sizeof *t);
    t->min_eff = 255;

    DWORD len = 0;
    GetLogicalProcessorInformationEx(RelationAll, NULL, &len);
    if (!len) return 0;
    BYTE *buf = (BYTE *)malloc(len);
    if (!buf || !GetLogicalProcessorInformationEx(RelationAll, (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)buf, &len)) {
        free(buf);
        return 0;
    }

    for (DWORD off = 0; off < len;) {
        PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX info = (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)(buf + off);
        if (info->Relationship == RelationProcessorCore) {
            const GROUP_AFFINITY *g = &info->Processor.GroupMask[0];
            if (g->Group == 0 && t->ncores < MAX_CORES) {
                t->core[t->ncores].efficiency = info->Processor.EfficiencyClass;
                t->core[t->ncores].mask = g->Mask;
                if (info->Processor.EfficiencyClass > t->max_eff) t->max_eff = info->Processor.EfficiencyClass;
                if (info->Processor.EfficiencyClass < t->min_eff) t->min_eff = info->Processor.EfficiencyClass;
                t->ncores++;
            } else if (g->Group != 0) {
                t->other_groups = 1;
            }
        } else if (info->Relationship == RelationCache && info->Cache.Level == 3) {
            /* Newer SDKs report GroupMasks[]; the single GroupMask covers the
             * one-group machines this is for. */
            const GROUP_AFFINITY *g = &info->Cache.GroupMask;
            if (g->Group == 0) {
                int seen = 0;
                for (unsigned i = 0; i < t->nl3; i++) if (t->l3[i].mask == g->Mask) { seen = 1; break; }
                if (!seen && t->nl3 < MAX_L3) {
                    t->l3[t->nl3].size_kb = info->Cache.CacheSize / 1024;
                    t->l3[t->nl3].mask = g->Mask;
                    t->nl3++;
                }
            }
        }
        off += info->Size;
    }
    free(buf);

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    t->logical = si.dwNumberOfProcessors;
    if (t->ncores == 0) return 0;
    if (t->min_eff == 255) t->min_eff = 0;
    return 1;
}

/* What to pin to, and why. Returns the mode name; fills the mask. */
static const char *recommend(const topology_t *t, KAFFINITY *mask)
{
    *mask = 0;
    if (t->max_eff > t->min_eff) {
        for (unsigned i = 0; i < t->ncores; i++)
            if (t->core[i].efficiency == t->max_eff) *mask |= t->core[i].mask;
        return "pcores";
    }
    if (t->nl3 >= 2) {
        DWORD big = 0, small = 0xFFFFFFFF;
        unsigned which = 0;
        for (unsigned i = 0; i < t->nl3; i++) {
            if (t->l3[i].size_kb > big) { big = t->l3[i].size_kb; which = i; }
            if (t->l3[i].size_kb < small) small = t->l3[i].size_kb;
        }
        if (big > small) { *mask = t->l3[which].mask; return "vcache"; }
    }
    return "none";
}

static KAFFINITY mask_for(const topology_t *t, const char *mode, const char **resolved)
{
    KAFFINITY rec = 0;
    const char *recname = recommend(t, &rec);
    if (!strcmp(mode, "auto")) { *resolved = recname; return rec; }
    if (!strcmp(mode, "pcores")) {
        KAFFINITY m = 0;
        for (unsigned i = 0; i < t->ncores; i++) if (t->core[i].efficiency == t->max_eff) m |= t->core[i].mask;
        *resolved = (t->max_eff > t->min_eff) ? "pcores" : "none";
        return (t->max_eff > t->min_eff) ? m : 0;
    }
    if (!strcmp(mode, "vcache")) {
        if (!strcmp(recname, "vcache")) { *resolved = "vcache"; return rec; }
        *resolved = "none";
        return 0;
    }
    if (!strncmp(mode, "mask:", 5)) {
        *resolved = "mask";
        return (KAFFINITY)_strtoui64(mode + 5, NULL, 16);
    }
    *resolved = "none";
    return 0;
}

static void print_mask(const char *key, KAFFINITY m, int trailing_comma)
{
    printf("\"%s\":\"0x%llX\"%s", key, (unsigned long long)m, trailing_comma ? "," : "");
}

static int cmd_topology(void)
{
    topology_t t;
    if (!read_topology(&t)) { puts("{\"error\":\"GetLogicalProcessorInformationEx failed\"}"); return REFUSED; }
    KAFFINITY rec = 0;
    const char *mode = recommend(&t, &rec);

    printf("{\"logical\":%u,\"cores\":%u,\"hybrid\":%s,\"other_groups\":%s,",
           t.logical, t.ncores, t.max_eff > t.min_eff ? "true" : "false", t.other_groups ? "true" : "false");
    printf("\"classes\":[");
    for (unsigned i = 0; i < t.ncores; i++)
        printf("%s{\"efficiency\":%u,\"mask\":\"0x%llX\"}", i ? "," : "", t.core[i].efficiency, (unsigned long long)t.core[i].mask);
    printf("],\"l3\":[");
    for (unsigned i = 0; i < t.nl3; i++)
        printf("%s{\"size_kb\":%lu,\"mask\":\"0x%llX\"}", i ? "," : "", t.l3[i].size_kb, (unsigned long long)t.l3[i].mask);
    printf("],\"recommend\":{\"mode\":\"%s\",", mode);
    print_mask("mask", rec, 0);
    puts("}}");
    return OK;
}

/* ── Affinity ─────────────────────────────────────────────────────*/
typedef BOOL (WINAPI *get_cpusets_fn)(PSYSTEM_CPU_SET_INFORMATION, ULONG, PULONG, HANDLE, ULONG);
typedef BOOL (WINAPI *set_default_cpusets_fn)(HANDLE, const ULONG *, ULONG);
typedef BOOL (WINAPI *get_default_cpusets_fn)(HANDLE, PULONG, ULONG, PULONG);

static HMODULE k32(void) { return GetModuleHandleW(L"kernel32.dll"); }

/* CPU set ids for the logical processors in `mask` (group 0). */
static unsigned cpuset_ids_for(KAFFINITY mask, ULONG *ids, unsigned cap)
{
    get_cpusets_fn get = (get_cpusets_fn)GetProcAddress(k32(), "GetSystemCpuSetInformation");
    if (!get) return 0;
    ULONG len = 0;
    get(NULL, 0, &len, NULL, 0);
    if (!len) return 0;
    BYTE *buf = (BYTE *)malloc(len);
    if (!buf || !get((PSYSTEM_CPU_SET_INFORMATION)buf, len, &len, NULL, 0)) { free(buf); return 0; }
    unsigned n = 0;
    for (ULONG off = 0; off < len;) {
        PSYSTEM_CPU_SET_INFORMATION cs = (PSYSTEM_CPU_SET_INFORMATION)(buf + off);
        if (cs->Type == CpuSetInformation && cs->CpuSet.Group == 0 && n < cap) {
            if (mask & ((KAFFINITY)1 << cs->CpuSet.LogicalProcessorIndex)) ids[n++] = cs->CpuSet.Id;
        }
        off += cs->Size;
    }
    free(buf);
    return n;
}

static int cmd_affinity(const char *pid_s, const char *mode)
{
    const DWORD pid = (DWORD)strtoul(pid_s, NULL, 10);
    HANDLE proc = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_INFORMATION | PROCESS_SET_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) { printf("{\"error\":\"OpenProcess failed\",\"code\":%lu}\n", GetLastError()); return REFUSED; }

    topology_t t;
    if (!read_topology(&t)) { CloseHandle(proc); puts("{\"error\":\"topology unavailable\"}"); return REFUSED; }

    const char *resolved = "none";
    KAFFINITY mask = mask_for(&t, mode, &resolved);

    set_default_cpusets_fn setdef = (set_default_cpusets_fn)GetProcAddress(k32(), "SetProcessDefaultCpuSets");

    if (!mask) {
        /* Clear what an earlier run may have set; never touch the hard mask. */
        int cleared = setdef ? setdef(proc, NULL, 0) : 0;
        CloseHandle(proc);
        printf("{\"applied\":false,\"mode\":\"%s\",\"cleared\":%s}\n", resolved, cleared ? "true" : "false");
        return OK;
    }

    /* Never pin to processors the process is not allowed on. */
    DWORD_PTR pmask = 0, smask = 0;
    if (GetProcessAffinityMask(proc, &pmask, &smask)) mask &= (KAFFINITY)smask;
    if (!mask) { CloseHandle(proc); puts("{\"error\":\"mask has no usable processor\"}"); return REFUSED; }

    ULONG ids[64];
    unsigned n = cpuset_ids_for(mask, ids, 64);
    const char *method = "cpusets";
    BOOL ok = FALSE;
    if (setdef && n) ok = setdef(proc, ids, n);
    if (!ok) {
        method = "affinity";
        ok = SetProcessAffinityMask(proc, (DWORD_PTR)mask);
    }
    const DWORD err = ok ? 0 : GetLastError();
    CloseHandle(proc);
    if (!ok) { printf("{\"error\":\"could not apply\",\"code\":%lu,\"mode\":\"%s\"}\n", err, resolved); return REFUSED; }
    printf("{\"applied\":true,\"mode\":\"%s\",\"method\":\"%s\",\"cpusets\":%u,", resolved, method, n);
    print_mask("mask", mask, 0);
    puts("}");
    return OK;
}

static int cmd_affinity_get(const char *pid_s)
{
    const DWORD pid = (DWORD)strtoul(pid_s, NULL, 10);
    HANDLE proc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!proc) { printf("{\"error\":\"OpenProcess failed\",\"code\":%lu}\n", GetLastError()); return REFUSED; }
    DWORD_PTR pmask = 0, smask = 0;
    GetProcessAffinityMask(proc, &pmask, &smask);
    ULONG ids[64];
    ULONG n = 0;
    get_default_cpusets_fn getdef = (get_default_cpusets_fn)GetProcAddress(k32(), "GetProcessDefaultCpuSets");
    if (getdef) getdef(proc, ids, 64, &n);
    CloseHandle(proc);
    printf("{\"affinity\":\"0x%llX\",\"system\":\"0x%llX\",\"cpusets\":[",
           (unsigned long long)pmask, (unsigned long long)smask);
    for (ULONG i = 0; i < n && i < 64; i++) printf("%s%lu", i ? "," : "", ids[i]);
    puts("]}");
    return OK;
}

/* ── Display ──────────────────────────────────────────────────────*/
static int current_mode(DEVMODEW *dm)
{
    memset(dm, 0, sizeof *dm);
    dm->dmSize = sizeof *dm;
    return EnumDisplaySettingsExW(NULL, ENUM_CURRENT_SETTINGS, dm, 0) != 0;
}

/* Refresh rates offered at the current resolution and depth, ascending. */
static unsigned rates_at(const DEVMODEW *cur, DWORD *out, unsigned cap)
{
    unsigned n = 0;
    DEVMODEW dm;
    for (DWORD i = 0;; i++) {
        memset(&dm, 0, sizeof dm);
        dm.dmSize = sizeof dm;
        if (!EnumDisplaySettingsExW(NULL, i, &dm, 0)) break;
        if (dm.dmPelsWidth != cur->dmPelsWidth || dm.dmPelsHeight != cur->dmPelsHeight) continue;
        if (dm.dmBitsPerPel != cur->dmBitsPerPel) continue;
        if (dm.dmDisplayFrequency <= 1) continue;
        int seen = 0;
        for (unsigned k = 0; k < n; k++) if (out[k] == dm.dmDisplayFrequency) { seen = 1; break; }
        if (!seen && n < cap) out[n++] = dm.dmDisplayFrequency;
    }
    for (unsigned a = 0; a < n; a++)
        for (unsigned b = a + 1; b < n; b++)
            if (out[b] < out[a]) { DWORD tmp = out[a]; out[a] = out[b]; out[b] = tmp; }
    return n;
}

static int cmd_display_query(void)
{
    DEVMODEW cur;
    if (!current_mode(&cur)) { puts("{\"error\":\"EnumDisplaySettings failed\"}"); return REFUSED; }
    DWORD rates[64];
    unsigned n = rates_at(&cur, rates, 64);
    printf("{\"width\":%lu,\"height\":%lu,\"hz\":%lu,\"max_hz\":%lu,\"rates\":[",
           cur.dmPelsWidth, cur.dmPelsHeight, cur.dmDisplayFrequency, n ? rates[n - 1] : cur.dmDisplayFrequency);
    for (unsigned i = 0; i < n; i++) printf("%s%lu", i ? "," : "", rates[i]);
    puts("]}");
    return OK;
}

static int set_rate(DWORD hz)
{
    DEVMODEW cur;
    if (!current_mode(&cur)) { puts("{\"error\":\"EnumDisplaySettings failed\"}"); return REFUSED; }
    const DWORD from = cur.dmDisplayFrequency;
    if (from == hz) { printf("{\"changed\":false,\"from\":%lu,\"to\":%lu}\n", from, hz); return OK; }

    DEVMODEW dm = cur;
    dm.dmDisplayFrequency = hz;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY;
    /* No CDS_UPDATEREGISTRY: dynamic for this session only, so a crash on our
     * side leaves the user's saved mode exactly as it was. */
    const LONG r = ChangeDisplaySettingsExW(NULL, &dm, NULL, 0, NULL);
    if (r != DISP_CHANGE_SUCCESSFUL) {
        printf("{\"error\":\"ChangeDisplaySettingsEx refused\",\"code\":%ld,\"from\":%lu,\"to\":%lu}\n", r, from, hz);
        return REFUSED;
    }
    printf("{\"changed\":true,\"from\":%lu,\"to\":%lu}\n", from, hz);
    return OK;
}

static int cmd_display_max(void)
{
    DEVMODEW cur;
    if (!current_mode(&cur)) { puts("{\"error\":\"EnumDisplaySettings failed\"}"); return REFUSED; }
    DWORD rates[64];
    unsigned n = rates_at(&cur, rates, 64);
    if (!n) { printf("{\"changed\":false,\"from\":%lu,\"to\":%lu}\n", cur.dmDisplayFrequency, cur.dmDisplayFrequency); return OK; }
    return set_rate(rates[n - 1]);
}

/* ── Main ─────────────────────────────────────────────────────────*/
static int usage(void)
{
    fputs("usage: librarian_tune topology\n"
          "       librarian_tune affinity <pid> <auto|pcores|vcache|none|mask:HEX>\n"
          "       librarian_tune affinity-get <pid>\n"
          "       librarian_tune display query|max|set <hz>\n", stderr);
    return USAGE;
}

int main(int argc, char **argv)
{
    if (argc < 2) return usage();
    const char *cmd = argv[1];
    if (!strcmp(cmd, "topology")) return cmd_topology();
    if (!strcmp(cmd, "affinity") && argc >= 4) return cmd_affinity(argv[2], argv[3]);
    if (!strcmp(cmd, "affinity-get") && argc >= 3) return cmd_affinity_get(argv[2]);
    if (!strcmp(cmd, "display") && argc >= 3) {
        if (!strcmp(argv[2], "query")) return cmd_display_query();
        if (!strcmp(argv[2], "max")) return cmd_display_max();
        if (!strcmp(argv[2], "set") && argc >= 4) return set_rate((DWORD)strtoul(argv[3], NULL, 10));
    }
    return usage();
}
