/*
 * EOS proxy — real Epic servers, anonymous identity.
 *
 * The emulator in ../eosemu replaces EOS entirely and keeps everything on the
 * LAN. This does the opposite and is far smaller: it lets Epic's real backend
 * do all the work — lobbies, Join Codes, NAT traversal, relays — and changes
 * exactly one thing on the way past.
 *
 * The one thing:
 *
 *   A game bought on Steam authenticates to EOS with a Steam ticket. That
 *   ticket is issued for the game's own App ID, and a copy that Steam does not
 *   consider owned cannot produce a valid one, so EOS_Connect_Login fails and
 *   co-op never starts. But EOS has a second, entirely legitimate credential
 *   type built in for exactly this shape of problem: Device ID. It is
 *   anonymous, needs no Epic account and no ownership, and Epic supports it
 *   as a first-class login path.
 *
 *   So: intercept EOS_Connect_Login, and if the game is presenting a Steam
 *   ticket, create a Device ID and log in with that instead. Every other one
 *   of the ~679 exports is a loader forwarder to the genuine SDK, with no code
 *   and no cost.
 *
 * Because the session is real, the Join Code a host shares is a real EOS lobby
 * id and works across the internet — no VPN, no shared LAN.
 *
 * Layout: the genuine SDK is renamed EOSSDK-Win64-Shipping_o.dll and this
 * takes its place. See install() in Librarian's onlineMode module.
 */

#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <windows.h>

#include "eos_sdk.h"
#include "eos_connect.h"
#include "eos_auth.h"
#include "eos_lobby.h"
#include "../overlay/overlay.h"

#define REAL_SDK "EOSSDK-Win64-Shipping_o.dll"

/* ── Logging ──────────────────────────────────────────────────── */
static void plog(const char *fmt, ...)
{
    static char path[MAX_PATH];
    static int ready = 0;
    if (!ready) {
        HMODULE self = NULL;
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                           | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)(void *)&plog, &self);
        if (GetModuleFileNameA(self, path, MAX_PATH)) {
        char *slash = strrchr(path, '\\');
            if (slash) { slash[1] = '\0'; strncat(path, "librarian_eos.log", MAX_PATH - strlen(path) - 1); }
        }
        ready = 1;
    }
    FILE *f = fopen(path, "a");
    if (!f) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(f, "[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap; va_start(ap, fmt); vfprintf(f, fmt, ap); va_end(ap);
    fputc('\n', f); fclose(f);
}

/* ── Player name ──────────────────────────────────────────────────
 * Device ID auth is anonymous, so nothing supplies a name and everyone in a
 * lobby shows up as the same placeholder. Read one from an ini beside the DLL
 * — Librarian writes it — so players can tell each other apart.
 *
 * The file sits next to the DLL rather than in the working directory: a game
 * may chdir before EOS starts, and this has to be findable whenever we get
 * here.
 */
static char g_player_name[64];

static void load_player_name(void)
{
    static int done = 0;
    if (done) return;
    done = 1;

    char path[MAX_PATH];
    HMODULE self = NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                       | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)(void *)&load_player_name, &self);
    if (!GetModuleFileNameA(self, path, MAX_PATH)) return;
    char *slash = strrchr(path, '\\');
    if (!slash) return;
    slash[1] = '\0';
    strncat(path, "librarian_online.ini", MAX_PATH - strlen(path) - 1);

    FILE *f = fopen(path, "r");
    if (!f) return;
    char line[192];
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, "player_name=", 12) != 0) continue;
        char *v = line + 12;
        v[strcspn(v, "\r\n")] = '\0';
        if (*v) strncpy(g_player_name, v, sizeof g_player_name - 1);
        break;
    }
    fclose(f);
}

/* ── The genuine SDK ──────────────────────────────────────────── */
/*
 * Load the genuine SDK by ABSOLUTE path, from our own directory.
 *
 * This is the trap that costs everyone their first proxy DLL. A forwarded
 * export is resolved by the loader using the standard search order, which
 * begins at the *executable's* directory — not at the directory of the DLL
 * doing the forwarding. Unity keeps its plugins in Plugins/x86_64 while the
 * exe sits in the game root, so a bare-name lookup for the renamed SDK finds
 * nothing, every forwarder resolves to null, and the game stalls with no
 * error anywhere.
 *
 * Loading it explicitly by full path during DLL_PROCESS_ATTACH puts the module
 * in the process under that name, so every later forwarder resolution finds it
 * already present and never consults the search path at all.
 */
static HMODULE real_sdk(void)
{
    static HMODULE h = NULL;
    if (h) return h;

    h = GetModuleHandleA(REAL_SDK);
    if (h) return h;

    char path[MAX_PATH];
    HMODULE self = NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                       | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)(void *)&real_sdk, &self);
    if (GetModuleFileNameA(self, path, MAX_PATH)) {
        char *slash = strrchr(path, '\\');
        if (slash) {
            slash[1] = '\0';
            strncat(path, REAL_SDK, MAX_PATH - strlen(path) - 1);
            h = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
            if (h) plog("loaded genuine SDK: %s", path);
            else   plog("FATAL: LoadLibraryEx failed for %s (err %lu)", path, GetLastError());
        }
    }
    if (!h) h = LoadLibraryA(REAL_SDK);   /* last resort: search path */
    if (!h) plog("FATAL: could not load %s", REAL_SDK);
    return h;
}

#define REAL(name) ((void *)GetProcAddress(real_sdk(), name))

typedef void (EOS_CALL *fn_connect_login)(EOS_HConnect, const EOS_Connect_LoginOptions *,
                                          void *, const EOS_Connect_OnLoginCallback);
typedef void (EOS_CALL *fn_create_device_id)(EOS_HConnect, const EOS_Connect_CreateDeviceIdOptions *,
                                             void *, const EOS_Connect_OnCreateDeviceIdCallback);

/*
 * The game's own callback and data, held across our two-step login. EOS is
 * single-threaded through Tick, so one slot in flight is enough — a game does
 * not start a second login while the first is outstanding.
 */
static struct {
    EOS_Connect_OnLoginCallback game_cb;
    void                       *game_data;
    EOS_HConnect                handle;
    char                        display_name[64];
} g_login;

/* Step 3: Epic answered our Device ID login. Hand the result to the game
 * unchanged — it never learns the credential type was swapped. */
static void EOS_CALL on_device_login(const EOS_Connect_LoginCallbackInfo *Data)
{
    plog("Connect_Login(DeviceID) -> result=%d", (int)Data->ResultCode);
    if (g_login.game_cb) {
        EOS_Connect_LoginCallbackInfo info = *Data;
        info.ClientData = g_login.game_data;
        g_login.game_cb(&info);
    }
    g_login.game_cb = NULL;
}

/* Step 2: the Device ID exists (or already did). Now log in with it. */
static void EOS_CALL on_device_created(const EOS_Connect_CreateDeviceIdCallbackInfo *Data)
{
    /* EOS_DuplicateNotAllowed simply means this machine already has one. */
    if (Data->ResultCode != EOS_Success && Data->ResultCode != EOS_DuplicateNotAllowed) {
        plog("CreateDeviceId failed: %d — passing failure to the game", (int)Data->ResultCode);
        if (g_login.game_cb) {
            EOS_Connect_LoginCallbackInfo info;
            memset(&info, 0, sizeof info);
            info.ResultCode = Data->ResultCode;
            info.ClientData = g_login.game_data;
            g_login.game_cb(&info);
            g_login.game_cb = NULL;
        }
        return;
    }

    EOS_Connect_Credentials creds;
    memset(&creds, 0, sizeof creds);
    creds.ApiVersion = EOS_CONNECT_CREDENTIALS_API_LATEST;
    creds.Token = NULL;                       /* Device ID carries no token */
    creds.Type = EOS_ECT_DEVICEID_ACCESS_TOKEN;

    EOS_Connect_UserLoginInfo info;
    memset(&info, 0, sizeof info);
    info.ApiVersion = EOS_CONNECT_USERLOGININFO_API_LATEST;
    load_player_name();
    /* configured name first, then whatever the game supplied, then a fallback */
    info.DisplayName = g_player_name[0] ? g_player_name
                     : (g_login.display_name[0] ? g_login.display_name : "Player");

    EOS_Connect_LoginOptions opts;
    memset(&opts, 0, sizeof opts);
    opts.ApiVersion = EOS_CONNECT_LOGIN_API_LATEST;
    opts.Credentials = &creds;
    opts.UserLoginInfo = &info;

    fn_connect_login real = (fn_connect_login)REAL("EOS_Connect_Login");
    if (!real) { plog("FATAL: real EOS_Connect_Login missing"); return; }
    plog("logging in as DeviceID, display name '%s'", info.DisplayName);
    real(g_login.handle, &opts, NULL, on_device_login);
}

/*
 * Reroute Steam-ticket logins to Device ID.
 *
 * The trace settled this rather than any reasoning of mine. The game logs in
 * with credentialType 18 (STEAM_SESSION_TICKET) and Epic answers 7000,
 * EOS_Connect_ExternalTokenValidationFailed — it hands the ticket to Steam's
 * Web API, which reports it was issued for app 480 rather than the game's own
 * id, so validation fails every time.
 *
 * steam_appid.txt cannot fix that; it is *why* the ticket says 480. The
 * session is still needed to get the game this far, which is exactly why
 * OnlineFix asks for Spacewar and then sets DeviceIdAuth=true: keep the Steam
 * session, but do not ask Epic to believe its ticket.
 *
 * Device ID is EOS's own anonymous credential — no app identity, no ownership
 * claim, nothing to reject — and the session it returns is real, which is what
 * makes a Join Code work over the internet.
 */
static EOS_Connect_OnLoginCallback g_game_login_cb;
static void *g_game_login_data;

static void EOS_CALL on_login_result(const EOS_Connect_LoginCallbackInfo *Data)
{
    plog("  Connect_Login RESULT = %d (%s)", (int)Data->ResultCode,
         Data->ResultCode == EOS_Success ? "SUCCESS" : "failed");
    /* Our own export of this is a forwarder, so it must be resolved from the
     * real SDK rather than called directly. */
    if (Data->LocalUserId) {
        typedef EOS_EResult (EOS_CALL *fn_puid_str)(EOS_ProductUserId, char*, int32_t*);
        fn_puid_str to_str = (fn_puid_str)REAL("EOS_ProductUserId_ToString");
        char id[64]; int32_t len = (int32_t)sizeof id;
        if (to_str && to_str(Data->LocalUserId, id, &len) == EOS_Success)
            plog("  ProductUserId = %s", id);
    }
    if (g_game_login_cb) {
        EOS_Connect_LoginCallbackInfo info = *Data;
        info.ClientData = g_game_login_data;
        g_game_login_cb(&info);
        g_game_login_cb = NULL;
    }
}

EOS_DECLARE_FUNC(void) EOS_Connect_Login(EOS_HConnect Handle,
                                         const EOS_Connect_LoginOptions *Options,
                                         void *ClientData,
                                         const EOS_Connect_OnLoginCallback CompletionDelegate)
{
    int type = (Options && Options->Credentials) ? (int)Options->Credentials->Type : -1;
    const char *tok = (Options && Options->Credentials) ? Options->Credentials->Token : NULL;
    plog("EOS_Connect_Login  credentialType=%d  token=%s", type,
         tok ? (strlen(tok) > 16 ? "(present, long)" : tok) : "(null)");

    fn_connect_login real = (fn_connect_login)REAL("EOS_Connect_Login");
    if (!real) { plog("  FATAL: real EOS_Connect_Login missing"); return; }

    g_game_login_cb = CompletionDelegate;
    g_game_login_data = ClientData;

    /* Anything that is not a Steam ticket already works — forward it. */
    int is_steam = (type == (int)EOS_ECT_STEAM_APP_TICKET)
                || (type == (int)EOS_ECT_STEAM_SESSION_TICKET);
    if (!is_steam) {
        plog("  not a Steam ticket -> forwarding unchanged");
        real(Handle, Options, NULL, on_login_result);
        return;
    }

    /* Epic will reject this ticket (7000). Create a Device ID and use that
     * instead; on_device_created finishes the login. */
    plog("  Steam ticket -> rerouting to Device ID");
    g_login.game_cb = CompletionDelegate;
    g_login.game_data = ClientData;
    g_login.handle = Handle;
    g_login.display_name[0] = '\0';
    if (Options && Options->UserLoginInfo && Options->UserLoginInfo->DisplayName)
        strncpy(g_login.display_name, Options->UserLoginInfo->DisplayName,
                sizeof g_login.display_name - 1);

    EOS_Connect_CreateDeviceIdOptions dopts;
    memset(&dopts, 0, sizeof dopts);
    dopts.ApiVersion = EOS_CONNECT_CREATEDEVICEID_API_LATEST;
    dopts.DeviceModel = "PC Windows 64-bit";

    fn_create_device_id create = (fn_create_device_id)REAL("EOS_Connect_CreateDeviceId");
    if (!create) {
        plog("  real CreateDeviceId missing -> forwarding original login");
        real(Handle, Options, NULL, on_login_result);
        return;
    }
    create(Handle, &dopts, NULL, on_device_created);
}

/* ── Pass-through probes ──────────────────────────────────────────
 * Each forwards untouched and exists only to record that the game reached it.
 * Guessing which auth path a game takes has already cost one failed run, so
 * the sequence is made observable instead. Signatures come from the SDK
 * headers — a mismatched one is a corrupted stack, not a log line. */
typedef EOS_HPlatform (EOS_CALL *fn_plat_create)(const EOS_Platform_Options*);
typedef void (EOS_CALL *fn_auth_login)(EOS_HAuth, const EOS_Auth_LoginOptions*, void*, const EOS_Auth_OnLoginCallback);
typedef void (EOS_CALL *fn_lobby_create)(EOS_HLobby, const EOS_Lobby_CreateLobbyOptions*, void*, const EOS_Lobby_OnCreateLobbyCallback);
typedef void (EOS_CALL *fn_tick)(EOS_HPlatform);

/*
 * Forwarded completely untouched — and that is the whole point.
 *
 * ProductId, SandboxId and DeploymentId identify which Epic backend the game
 * talks to, and they are baked into the game by its developer. We never supply
 * or alter them, so the lobbies and sessions reached here are the *real* ones
 * for this title, shared with everyone else playing it. Spacewar (480) lives
 * entirely on the Steam side and has no bearing on which EOS deployment this
 * is; the only thing changed anywhere in this file is the credential type used
 * to log in.
 *
 * They are logged so that claim is checkable rather than something to take on
 * trust: compare them against the game's own configuration and they match.
 */
EOS_DECLARE_FUNC(EOS_HPlatform) EOS_Platform_Create(const EOS_Platform_Options* Options)
{
    if (Options) {
        plog("EOS_Platform_Create  ProductId=%s", Options->ProductId ? Options->ProductId : "(null)");
        plog("                     SandboxId=%s", Options->SandboxId ? Options->SandboxId : "(null)");
        plog("                     DeploymentId=%s", Options->DeploymentId ? Options->DeploymentId : "(null)");
        plog("                     ClientId=%s  isServer=%d",
             Options->ClientCredentials.ClientId ? Options->ClientCredentials.ClientId : "(null)",
             (int)Options->bIsServer);
    }
    fn_plat_create f = (fn_plat_create)REAL("EOS_Platform_Create");
    EOS_HPlatform h = f ? f(Options) : NULL;
    plog("                     -> platform=%p (options forwarded unmodified)", (void*)h);
    return h;
}

EOS_DECLARE_FUNC(void) EOS_Auth_Login(EOS_HAuth Handle, const EOS_Auth_LoginOptions* Options,
                                      void* ClientData, const EOS_Auth_OnLoginCallback Delegate)
{
    plog("EOS_Auth_Login  <-- Epic-account auth path");
    fn_auth_login f = (fn_auth_login)REAL("EOS_Auth_Login");
    if (f) f(Handle, Options, ClientData, Delegate);
}

EOS_DECLARE_FUNC(void) EOS_Lobby_CreateLobby(EOS_HLobby Handle, const EOS_Lobby_CreateLobbyOptions* Options,
                                             void* ClientData, const EOS_Lobby_OnCreateLobbyCallback Delegate)
{
    plog("EOS_Lobby_CreateLobby");
    fn_lobby_create f = (fn_lobby_create)REAL("EOS_Lobby_CreateLobby");
    if (f) f(Handle, Options, ClientData, Delegate);
}

EOS_DECLARE_FUNC(void) EOS_Platform_Tick(EOS_HPlatform Handle)
{
    static unsigned n = 0;
    if ((n++ % 1200) == 0) plog("Tick #%u", n);
    fn_tick f = (fn_tick)REAL("EOS_Platform_Tick");
    if (f) f(Handle);
}

/* overlay.c formats its own lines; this only gives them somewhere to go. */
static void overlay_log(const char *line) { plog("%s", line); }

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        plog("--- Librarian EOS proxy loaded ---");
        real_sdk();   /* resolve now, so forwarders never hit the search path */
        librarian_overlay_init(overlay_log);   /* returns immediately; see overlay.c */
    }
    return TRUE;
}
