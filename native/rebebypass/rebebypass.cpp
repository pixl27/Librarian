/*
 * Librarian Rebe auth bypass — REFramework native plugin (MH Wilds, private co-op).
 *
 * The game's /sign consumer (native, code rva 0xa75a070) rejects every response our local
 * server can craft: measured sub=-1/JsonFormat for 1/2/3/5-part tokens alike, a correct
 * 3-part JWT failing identically to garbage (see memory wilds-sign-consumer-rejects-any-token).
 * So we cannot SATISFY auth with a token — for a PRIVATE server we instead make the game
 * BELIEVE it is authorized, then let it flow into our local REST control server + PartyWin.dll shim.
 *
 * via.rebe.RebeService.get_State / get_Authorized are static, read-only (no setter), native-computed.
 * We post-hook them: let the real auth run and FAIL first (so early boot/network init is untouched),
 * and only AFTER we observe the real state reach Running(2) or Failed(4) do we start forcing
 * get_State -> Authorized(3) and get_Authorized -> true. A native hook has negligible per-call cost,
 * unlike the Lua per-frame hook that once froze REFramework.
 *
 * This is a probe: forcing these two getters may or may not be sufficient to reach session creation
 * (the game may gate on other native fields, and PlayFab LoginWithSteam is a likely next wall).
 * wilds_rebe_state.lua + the local server log show whether the game advances.
 *
 * Build: node native/rebebypass/build.js  ->  out/rebebypass.dll
 * Install: tools/wilds-private-server/install-rebebypass.ps1  -> <game>/reframework/plugins/
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include <atomic>

#include "reframework/API.hpp"

using namespace reframework;

namespace {
enum : int { STATE_RUNNING = 2, STATE_AUTHORIZED = 3, STATE_FAILED = 4 };

std::atomic<bool> g_armed{false};   // real auth has run (state hit Running/Failed) -> safe to force
std::atomic<long>  g_forcedState{0};
std::atomic<long>  g_forcedAuth{0};
char g_logPath[MAX_PATH] = {};

void logf(const char* fmt, ...) {
    if (!g_logPath[0]) return;
    char msg[512];
    va_list ap; va_start(ap, fmt); vsnprintf(msg, sizeof msg, fmt, ap); va_end(ap);
    SYSTEMTIME t; GetLocalTime(&t);
    FILE* f = nullptr;
    if (fopen_s(&f, g_logPath, "ab") == 0 && f) {
        fprintf(f, "[%02d:%02d:%02d.%03d] %s\r\n", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, msg);
        fclose(f);
    }
}

int pre_noop(int, void**, REFrameworkTypeDefinitionHandle*, unsigned long long) {
    return REFRAMEWORK_HOOK_CALL_ORIGINAL;
}

// get_State(): read the real value; arm once it reaches Running/Failed; then force Authorized.
void post_get_state(void** ret_val, REFrameworkTypeDefinitionHandle, unsigned long long) {
    const int real = (int)(intptr_t)*ret_val;
    if (!g_armed.load(std::memory_order_relaxed) && (real == STATE_RUNNING || real == STATE_FAILED)) {
        g_armed.store(true, std::memory_order_relaxed);
        logf("armed: real RebeService state reached %d (Running/Failed); now forcing Authorized", real);
    }
    if (g_armed.load(std::memory_order_relaxed) && real != STATE_AUTHORIZED) {
        *ret_val = (void*)(intptr_t)STATE_AUTHORIZED;
        long n = ++g_forcedState;
        if (n <= 3 || (n % 600) == 0) logf("get_State: real=%d -> forced Authorized(3) [x%ld]", real, n);
    }
}

// get_Authorized(): once armed, force true.
void post_get_authorized(void** ret_val, REFrameworkTypeDefinitionHandle, unsigned long long) {
    if (g_armed.load(std::memory_order_relaxed)) {
        const int real = (int)(intptr_t)*ret_val;
        if (real == 0) {
            *ret_val = (void*)(intptr_t)1;
            long n = ++g_forcedAuth;
            if (n <= 3 || (n % 600) == 0) logf("get_Authorized: real=0 -> forced true [x%ld]", n);
        }
    }
}
} // namespace

extern "C" __declspec(dllexport) void reframework_plugin_required_version(REFrameworkPluginVersion* v) {
    v->major = REFRAMEWORK_PLUGIN_VERSION_MAJOR;
    v->minor = REFRAMEWORK_PLUGIN_VERSION_MINOR;
    v->patch = REFRAMEWORK_PLUGIN_VERSION_PATCH;
}

extern "C" __declspec(dllexport) bool reframework_plugin_initialize(const REFrameworkPluginInitializeParam* param) {
    // Log next to the game's other Librarian logs.
    GetModuleFileNameA(nullptr, g_logPath, MAX_PATH);
    if (char* slash = strrchr(g_logPath, '\\')) { slash[1] = 0; strncat_s(g_logPath, "librarian_rebebypass.log", _TRUNCATE); }

    try {
        API::initialize(param);
    } catch (const std::exception& e) {
        logf("API init failed: %s", e.what());
        return false;
    }

    auto tdb = API::get()->tdb();
    auto m_state = tdb->find_method("via.rebe.RebeService", "get_State");
    auto m_auth = tdb->find_method("via.rebe.RebeService", "get_Authorized");
    if (!m_state && !m_auth) { logf("RebeService getters not found in TDB"); return true; }

    if (m_state) { m_state->add_hook(pre_noop, post_get_state, false); logf("hooked RebeService.get_State"); }
    else logf("get_State not found");
    if (m_auth) { m_auth->add_hook(pre_noop, post_get_authorized, false); logf("hooked RebeService.get_Authorized"); }
    else logf("get_Authorized not found");

    logf("rebebypass initialized (will force Authorized after the real auth attempt runs)");
    return true;
}
