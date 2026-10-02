/*
 * Steam API proxy — the six answers a Spacewar session gets wrong.
 *
 * Online mode opens a real Steam session under Spacewar (480), because every
 * account owns it. That gets Valve's actual lobbies, P2P and relay. But the
 * session belongs to app 480, and the game keeps asking questions about
 * *itself*:
 *
 *     "do I own 1478500?"        -> Steam answers no
 *     "what app am I?"           -> Steam answers 480
 *     "should I relaunch?"       -> Steam may say yes
 *
 * A text file cannot change those answers; only something sitting in the call
 * path can. That is all this is. Every other export — 1053 of them — is a
 * loader forwarder declared in the generated .def, so it reaches the real
 * library with no code and no cost. This file is deliberately the entire
 * behavioural surface, small enough to read in one sitting.
 *
 * Build: see build.js. The real library is renamed steam_api64_o.dll and this
 * takes its place.
 */

#include <windows.h>
#include <stdint.h>
#include <stdio.h>

#include "../overlay/overlay.h"

#ifndef bool
typedef unsigned char bool_t;
#define TRUE_V 1
#define FALSE_V 0
#else
typedef bool bool_t;
#define TRUE_V true
#define FALSE_V false
#endif

/* Filled from librarian_online.ini, written beside the DLL by Librarian. */
static uint32_t g_real_app_id = 0;
static int      g_own_everything = 1;   /* answer ownership questions yes */
static int      g_spoof_app_id  = 1;    /* report the game's own id back  */

#define REAL_LIB "steam_api64_o.dll"

static HMODULE  g_original = NULL;

typedef bool_t   (*fn_bool_self)(void *self);
typedef bool_t   (*fn_bool_self_u32)(void *self, uint32_t app);
typedef uint32_t (*fn_u32_self)(void *self);

/*
 * Load the genuine library by ABSOLUTE path, from our own directory.
 *
 * A bare-name LoadLibrary looks nothing like a bug and is one. The loader
 * resolves it with the standard search order, which starts at the
 * *executable's* directory — not at the directory of the DLL asking. Unity
 * keeps steam_api64.dll in <Game>_Data/Plugins/x86_64 and Unreal under
 * Engine/Binaries/ThirdParty/Steamworks/..., both a long way from the exe, so
 * the lookup finds nothing and every forwarded export resolves to null. The
 * game then dies with no message anywhere. This is the same trap the EOS proxy
 * hit; see native/eosproxy/proxy.c for the version that cost a debugging round.
 *
 * Loading it explicitly during DLL_PROCESS_ATTACH registers the module under
 * that name, so every later forwarder resolution finds it already present and
 * never consults the search path at all.
 */
static HMODULE real_lib(void)
{
    if (g_original) return g_original;

    g_original = GetModuleHandleA(REAL_LIB);
    if (g_original) return g_original;

    char path[MAX_PATH];
    HMODULE self = NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                       | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)(void *)&real_lib, &self);
    if (GetModuleFileNameA(self, path, MAX_PATH)) {
        char *slash = strrchr(path, '\\');
        if (slash) {
            slash[1] = '\0';
            strncat(path, REAL_LIB, MAX_PATH - strlen(path) - 1);
            g_original = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
        }
    }
    if (!g_original) g_original = LoadLibraryA(REAL_LIB);   /* last resort */
    return g_original;
}

/* Resolve a symbol in the real library, for the cases we choose to pass on. */
static FARPROC original(const char *name)
{
    HMODULE h = real_lib();
    return h ? GetProcAddress(h, name) : NULL;
}

/*
 * Config lives next to the DLL rather than in the working directory: a game
 * may chdir before initialising Steam, and this has to be readable whenever
 * the loader gets here.
 */
static void load_config(HMODULE self)
{
    char path[MAX_PATH];
    if (!GetModuleFileNameA(self, path, MAX_PATH)) return;
    char *slash = strrchr(path, '\\');
    if (!slash) return;
    slash[1] = '\0';
    strncat(path, "librarian_online.ini", MAX_PATH - strlen(path) - 1);

    FILE *f = fopen(path, "r");
    if (!f) return;

    char line[256];
    while (fgets(line, sizeof line, f)) {
        unsigned long v;
        if (sscanf(line, "appid=%lu", &v) == 1)          g_real_app_id   = (uint32_t)v;
        else if (sscanf(line, "own_everything=%lu", &v) == 1) g_own_everything = (int)v;
        else if (sscanf(line, "spoof_appid=%lu", &v) == 1)    g_spoof_app_id   = (int)v;
    }
    fclose(f);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        load_config(inst);
        real_lib();   /* resolve now, so forwarders never hit the search path */
        /* No logger here, so overlay.c writes its own librarian_overlay.log. */
        librarian_overlay_init(NULL);
    }
    return TRUE;
}

/* ── Ownership ────────────────────────────────────────────────────
 * The session owns Spacewar, not the game, so these would all answer no.
 * A game that gates startup on them refuses to run; one that uses them for
 * optional content silently drops it. */

bool_t SteamAPI_ISteamApps_BIsSubscribed(void *self)
{
    if (g_own_everything) return TRUE_V;
    fn_bool_self f = (fn_bool_self)original("SteamAPI_ISteamApps_BIsSubscribed");
    return f ? f(self) : TRUE_V;
}

bool_t SteamAPI_ISteamApps_BIsSubscribedApp(void *self, uint32_t app)
{
    if (g_own_everything) return TRUE_V;
    fn_bool_self_u32 f = (fn_bool_self_u32)original("SteamAPI_ISteamApps_BIsSubscribedApp");
    return f ? f(self, app) : TRUE_V;
}

bool_t SteamAPI_ISteamApps_BIsSubscribedFromFreeWeekend(void *self)
{
    /* Answering yes here would make a game think it is on a trial and lock
     * content, so this one deliberately says no. */
    (void)self;
    return FALSE_V;
}

bool_t SteamAPI_ISteamApps_BIsDlcInstalled(void *self, uint32_t app)
{
    if (g_own_everything) return TRUE_V;
    fn_bool_self_u32 f = (fn_bool_self_u32)original("SteamAPI_ISteamApps_BIsDlcInstalled");
    return f ? f(self, app) : FALSE_V;
}

/* ── Identity ─────────────────────────────────────────────────────
 * Steam's own calls keep using the real session (480); this only changes what
 * the *game's* code sees when it asks who it is — which is what it uses to
 * build lobby keys and save paths. */

uint32_t SteamAPI_ISteamUtils_GetAppID(void *self)
{
    if (g_spoof_app_id && g_real_app_id) return g_real_app_id;
    fn_u32_self f = (fn_u32_self)original("SteamAPI_ISteamUtils_GetAppID");
    return f ? f(self) : g_real_app_id;
}

/* ── Startup ──────────────────────────────────────────────────────
 * With steam_appid.txt present the real function already returns false, but
 * only if the game's working directory is what we think it is. Answering here
 * removes that assumption: the game is never bounced back through Steam. */

bool_t SteamAPI_RestartAppIfNecessary(uint32_t own_app_id)
{
    (void)own_app_id;
    return FALSE_V;
}

/* ── Lobby scoping ────────────────────────────────────────────────
 * The awkward consequence of Spacewar: the session belongs to app 480, so
 * every lobby the game creates lives in 480's space — shared globally with
 * everyone else running this trick, for entirely unrelated games. A plain
 * lobby search comes back full of strangers' lobbies, and joining one does
 * nothing useful.
 *
 * The fix is a private key. Each lobby we create is stamped with the real App
 * ID, and every search we issue demands that same value, so a player only ever
 * sees lobbies belonging to the game they are actually running.
 *
 * Friend invites never touch any of this — they carry a lobby id directly and
 * skip the search entirely, which is why they work even without scoping.
 */
#define SCOPE_KEY "librarian_app"

typedef bool_t (*fn_set_lobby_data)(void *self, uint64_t lobby, const char *key, const char *val);
typedef void   (*fn_add_str_filter)(void *self, const char *key, const char *val, int cmp);
typedef uint64_t (*fn_request_lobby_list)(void *self);
typedef uint64_t (*fn_join_lobby)(void *self, uint64_t lobby);
typedef bool_t (*fn_set_lobby_type)(void *self, uint64_t lobby, int type);
typedef bool_t (*fn_set_lobby_joinable)(void *self, uint64_t lobby, bool_t joinable);
typedef bool_t (*fn_set_lobby_member_limit)(void *self, uint64_t lobby, int limit);

static const char *scope_value(void)
{
    static char buf[16];
    if (!buf[0]) snprintf(buf, sizeof buf, "%u", g_real_app_id ? g_real_app_id : 0u);
    return buf;
}

/*
 * Which lobbies already carry the stamp.
 *
 * Four different calls can trigger it now and a lobby only needs it once, so
 * this keeps the extra entry points from costing a round trip to Steam each.
 * Sixteen slots is far more than a game holds open at a time; a race between
 * two threads costs one redundant stamp and nothing else.
 */
#define STAMP_MEMO 16
static uint64_t g_stamped[STAMP_MEMO];
static unsigned g_stamp_next;

static int already_stamped(uint64_t lobby)
{
    for (unsigned i = 0; i < STAMP_MEMO; i++) if (g_stamped[i] == lobby) return 1;
    return 0;
}

/*
 * Mark a lobby we own with the real App ID.
 *
 * SetLobbyData only succeeds for the lobby's owner, so a client joining someone
 * else's game quietly does nothing here — which is correct, and is why the
 * return value is what decides whether to remember it.
 */
static void stamp_lobby(void *self, uint64_t lobby)
{
    if (!g_real_app_id || !lobby || already_stamped(lobby)) return;
    fn_set_lobby_data f = (fn_set_lobby_data)original("SteamAPI_ISteamMatchmaking_SetLobbyData");
    if (!f) return;
    if (f(self, lobby, SCOPE_KEY, scope_value()))
        g_stamped[g_stamp_next++ % STAMP_MEMO] = lobby;
}

/*
 * Why the stamp is posted from four places rather than one.
 *
 * It used to live only in SetLobbyData, on the assumption that a host writes
 * something about its lobby after creating it. Plenty of games never do — they
 * set the type, set the member limit, and start listening. That lobby went out
 * unstamped, and since RequestLobbyList below *requires* the key, our own
 * search could never return it: invisible to exactly the players it was meant
 * to reach, which is worse than not scoping at all.
 *
 * So every call a host normally makes on a freshly created lobby is treated as
 * a stamping opportunity.
 */
bool_t SteamAPI_ISteamMatchmaking_SetLobbyData(void *self, uint64_t lobby,
                                               const char *key, const char *val)
{
    fn_set_lobby_data f = (fn_set_lobby_data)original("SteamAPI_ISteamMatchmaking_SetLobbyData");
    if (!f) return FALSE_V;
    bool_t r = f(self, lobby, key, val);
    /* stamp_lobby calls the real library directly, so this cannot re-enter. */
    if (!key || strcmp(key, SCOPE_KEY) != 0) stamp_lobby(self, lobby);
    return r;
}

bool_t SteamAPI_ISteamMatchmaking_SetLobbyType(void *self, uint64_t lobby, int type)
{
    fn_set_lobby_type f = (fn_set_lobby_type)original("SteamAPI_ISteamMatchmaking_SetLobbyType");
    bool_t r = f ? f(self, lobby, type) : FALSE_V;
    stamp_lobby(self, lobby);
    return r;
}

bool_t SteamAPI_ISteamMatchmaking_SetLobbyJoinable(void *self, uint64_t lobby, bool_t joinable)
{
    fn_set_lobby_joinable f = (fn_set_lobby_joinable)original("SteamAPI_ISteamMatchmaking_SetLobbyJoinable");
    bool_t r = f ? f(self, lobby, joinable) : FALSE_V;
    stamp_lobby(self, lobby);
    return r;
}

bool_t SteamAPI_ISteamMatchmaking_SetLobbyMemberLimit(void *self, uint64_t lobby, int limit)
{
    fn_set_lobby_member_limit f = (fn_set_lobby_member_limit)original("SteamAPI_ISteamMatchmaking_SetLobbyMemberLimit");
    bool_t r = f ? f(self, lobby, limit) : FALSE_V;
    stamp_lobby(self, lobby);
    return r;
}

uint64_t SteamAPI_ISteamMatchmaking_RequestLobbyList(void *self)
{
    /* Filters apply to the *next* request, so this has to be added before the
     * call is forwarded, not after. */
    if (g_real_app_id) {
        fn_add_str_filter add =
            (fn_add_str_filter)original("SteamAPI_ISteamMatchmaking_AddRequestLobbyListStringFilter");
        if (add) add(self, SCOPE_KEY, scope_value(), 0 /* k_ELobbyComparisonEqual */);
    }
    fn_request_lobby_list f =
        (fn_request_lobby_list)original("SteamAPI_ISteamMatchmaking_RequestLobbyList");
    return f ? f(self) : 0;
}

/* Passed through untouched — present only so a future build can tell a
 * friend-invite join (no scoping involved) from a search result. */
uint64_t SteamAPI_ISteamMatchmaking_JoinLobby(void *self, uint64_t lobby)
{
    fn_join_lobby f = (fn_join_lobby)original("SteamAPI_ISteamMatchmaking_JoinLobby");
    return f ? f(self, lobby) : 0;
}
