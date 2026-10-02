/*
 * Harness for the achievement watch in librarian_achoverlay.dll — the Big
 * Walk crash of 2026-09-05, without Big Walk.
 *
 *   host.exe <game root> <plugin dir> <achoverlay.dll> [seconds]
 *
 * Loads <plugin dir>\steam_api64.dll (Librarian's proxy, which forwards to
 * the real steam_api64_o.dll beside it — or an emulator, or a bare Valve
 * library), initialises Steam from <game root> (whose steam_appid.txt decides
 * the app; 480 is what online mode uses), then loads the overlay the way the
 * injector would. Its watch thread resolves ISteamUserStats exactly as it does
 * inside a game, and its log lands beside this executable.
 *
 * Steam must be running and logged in for a Valve library; an emulator needs
 * nothing. Built and driven by dev/verify-achoverlay.mjs.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int  (__cdecl *init_fn)(void);
typedef int  (__cdecl *initflat_fn)(void *);
typedef void (__cdecl *void_fn)(void);
typedef int  (__cdecl *hsteamuser_fn)(void);
typedef void *(__cdecl *finduser_fn)(int, const char *);
typedef int  (__cdecl *reqstats_fn)(void *);
typedef unsigned (__cdecl *numach_fn)(void *);
typedef const char *(__cdecl *achname_fn)(void *, unsigned);

int main(int argc, char **argv)
{
    if (argc < 4) { fprintf(stderr, "usage: host <game root> <plugin dir> <achoverlay.dll> [seconds]\n"); return 2; }
    const char *root = argv[1], *plugins = argv[2], *overlay = argv[3];
    const int seconds = argc > 4 ? atoi(argv[4]) : 12;

    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    SetCurrentDirectoryA(root);
    SetDllDirectoryA(plugins);

    char api[MAX_PATH];
    _snprintf(api, sizeof api, "%s\\steam_api64.dll", plugins);
    HMODULE steam = LoadLibraryExA(api, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!steam) { fprintf(stderr, "LoadLibrary(%s) failed: %lu\n", api, GetLastError()); return 3; }
    printf("steam_api64.dll loaded at %p (%s)\n", (void *)steam, api);
    HMODULE orig = GetModuleHandleA("steam_api64_o.dll");
    printf("steam_api64_o.dll %s\n", orig ? "loaded (proxy forwarders resolved)" : "not loaded (no proxy)");

    /* SDK 1.59 and later export SteamAPI_InitFlat and keep SteamAPI_Init as
     * an inline in the header; older ones export SteamAPI_Init itself. */
    init_fn init = (init_fn)GetProcAddress(steam, "SteamAPI_Init");
    initflat_fn initflat = (initflat_fn)GetProcAddress(steam, "SteamAPI_InitFlat");
    void_fn shutdown = (void_fn)GetProcAddress(steam, "SteamAPI_Shutdown");
    void_fn runcb = (void_fn)GetProcAddress(steam, "SteamAPI_RunCallbacks");
    hsteamuser_fn hsu = (hsteamuser_fn)GetProcAddress(steam, "SteamAPI_GetHSteamUser");
    if ((!init && !initflat) || !shutdown || !runcb || !hsu) { fprintf(stderr, "core exports missing\n"); return 4; }

    /* What the flat exports were built for: printed so the overlay log can
     * be read against it. */
    for (int v = 15; v >= 10; v--) {
        char name[64]; _snprintf(name, sizeof name, "SteamAPI_SteamUserStats_v%03d", v);
        if (GetProcAddress(steam, name)) printf("  %s: exported\n", name);
    }

    int ok = init ? init() : (initflat(NULL) == 0);
    if (!ok) { fprintf(stderr, "SteamAPI_Init failed (is Steam running and logged in? does steam_appid.txt name an app you can run?)\n"); return 5; }
    printf("SteamAPI_Init ok via %s, HSteamUser=%d\n", init ? "SteamAPI_Init" : "SteamAPI_InitFlat", hsu());

    /* A game asks for its stats itself at start-up; before VERSION013 no
     * definition exists until this has been answered. */
    finduser_fn finduser = (finduser_fn)GetProcAddress(steam, "SteamInternal_FindOrCreateUserInterface");
    reqstats_fn req = (reqstats_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_RequestCurrentStats");
    numach_fn numach = (numach_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_GetNumAchievements");
    achname_fn achname = (achname_fn)GetProcAddress(steam, "SteamAPI_ISteamUserStats_GetAchievementName");
    void *stats012 = finduser ? finduser(hsu(), "STEAMUSERSTATS_INTERFACE_VERSION012") : NULL;
    void *stats013 = finduser ? finduser(hsu(), "STEAMUSERSTATS_INTERFACE_VERSION013") : NULL;
    printf("client offers VERSION012=%p VERSION013=%p\n", stats012, stats013);
    if (req && stats012) printf("RequestCurrentStats(012) -> %d\n", req(stats012));

    /* Control readings through both interfaces. A count that is not a count
     * shows which one the flat exports were built for. Read, never
     * dereferenced. */
    if (numach && stats012) printf("flat GetNumAchievements via VERSION012 = %u\n", numach(stats012));
    if (numach && stats013) printf("flat GetNumAchievements via VERSION013 = %u\n", numach(stats013));

    HMODULE ov = LoadLibraryA(overlay);
    if (!ov) { fprintf(stderr, "LoadLibrary(%s) failed: %lu\n", overlay, GetLastError()); shutdown(); return 6; }
    printf("overlay loaded at %p; pumping callbacks for %ds\n", (void *)ov, seconds);

    for (int i = 0; i < seconds * 10; i++) { runcb(); Sleep(100); }

    void *stats = stats013 ? stats013 : stats012;
    if (numach && achname && stats) {
        /* Through whichever interface the library's own accessor picks, if it
         * has one; otherwise the newest the client gave. */
        for (int v = 15; v >= 10; v--) {
            char name[64]; _snprintf(name, sizeof name, "SteamAPI_SteamUserStats_v%03d", v);
            void *(__cdecl *acc)(void) = (void *(__cdecl *)(void))GetProcAddress(steam, name);
            if (acc) { stats = acc(); break; }
        }
        unsigned n = numach(stats);
        printf("after pump: %u definition(s)", n);
        for (unsigned i = 0; i < n && i < 8; i++) printf("%s%s", i ? ", " : ": ", achname(stats, i));
        printf("\n");
    }
    shutdown();
    printf("shutdown ok; exit 0\n");
    return 0;
}
