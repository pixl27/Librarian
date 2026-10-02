/*
 * Steam overlay loader.
 *
 * Steam injects GameOverlayRenderer64.dll into processes *Steam itself starts*.
 * Librarian starts the executable directly, so that never happens and Shift+Tab,
 * screenshots and Steam invites are all missing — restoring the genuine
 * steam_api does not bring them back, because the overlay was never a function
 * of the API at all.
 *
 * What does bring it back is loading that library ourselves. Steam records
 * where it lives in the registry, so this reads the path, sets the two
 * environment variables the overlay uses to identify the session, and calls
 * LoadLibrary. That is the entire mechanism. (It is also, as far as the import
 * table shows, exactly what OnlineFix's SteamOverlay64.dll does — kernel32,
 * user32 and advapi32 only, no rendering code of its own.)
 *
 * Three details are load-bearing:
 *
 *   Thread. LoadLibrary from DllMain runs the loaded DLL's own DllMain while we
 *   still hold the loader lock, and this one installs D3D/Vulkan hooks and
 *   starts threads of its own. That is the textbook deadlock. Starting a thread
 *   from DllMain is fine — Windows will not schedule it until the lock is
 *   released — so the work happens there and DllMain returns immediately.
 *
 *   Path. SteamPath is stored the way Steam feels like storing it: this machine
 *   has "e:/games/steam", forward slashes and lowercase. Anything that assumes
 *   backslashes finds nothing.
 *
 *   Opt-in. An absent steam_overlay= key means off. A game running today works
 *   without the overlay, and pulling a large third-party library into a process
 *   that never expected it is exactly the kind of change that should not happen
 *   by inheritance when someone updates Librarian.
 */

#include <windows.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#include "overlay.h"

#define OVERLAY_DLL  "GameOverlayRenderer64.dll"
#define CONFIG_FILE  "librarian_online.ini"
#define DEFAULT_APPID "480"

static librarian_log_fn g_log;

static int self_dir(char *out, size_t cap);

/*
 * A host that has a log gets the line; one that does not gets a file beside the
 * DLL. Whether this worked is not something to have to guess at, and the answer
 * lives on the player's machine rather than anywhere we can see.
 */
static void fallback_log(const char *line)
{
    char path[MAX_PATH];
    if (!self_dir(path, sizeof path)) return;
    strncat(path, "librarian_overlay.log", sizeof path - strlen(path) - 1);
    FILE *f = fopen(path, "a");
    if (!f) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(f, "[%02d:%02d:%02d] %s\n", t.wHour, t.wMinute, t.wSecond, line);
    fclose(f);
}

static void olog(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (g_log) g_log(line);
    else       fallback_log(line);
}

/*
 * The directory this DLL was loaded from, with a trailing backslash.
 *
 * Not the working directory: a game may chdir before it touches any of this,
 * and the ini sits beside the DLL precisely so it stays findable.
 */
static int self_dir(char *out, size_t cap)
{
    HMODULE self = NULL;
    if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                            | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            (LPCSTR)(void *)&self_dir, &self))
        return 0;
    if (!GetModuleFileNameA(self, out, (DWORD)cap)) return 0;
    char *slash = strrchr(out, '\\');
    if (!slash) return 0;
    slash[1] = '\0';
    return 1;
}

/* Read one key from the ini beside us. Returns 0 if the key is absent. */
static int config_value(const char *key, char *out, size_t cap)
{
    char path[MAX_PATH];
    if (!self_dir(path, sizeof path)) return 0;
    strncat(path, CONFIG_FILE, sizeof path - strlen(path) - 1);

    FILE *f = fopen(path, "r");
    if (!f) return 0;

    const size_t klen = strlen(key);
    int found = 0;
    char line[256];
    while (fgets(line, sizeof line, f)) {
        if (strncmp(line, key, klen) != 0 || line[klen] != '=') continue;
        char *v = line + klen + 1;
        v[strcspn(v, "\r\n")] = '\0';
        strncpy(out, v, cap - 1);
        out[cap - 1] = '\0';
        found = 1;
        break;
    }
    fclose(f);
    return found;
}

/* A REG_SZ, read from a 32-bit view of HKLM where that matters (Steam is x86). */
static int reg_string(HKEY root, const char *subkey, const char *value,
                      REGSAM extra, char *out, DWORD cap)
{
    HKEY k;
    if (RegOpenKeyExA(root, subkey, 0, KEY_READ | extra, &k) != ERROR_SUCCESS) return 0;
    DWORD type = 0, size = cap;
    LONG r = RegQueryValueExA(k, value, NULL, &type, (LPBYTE)out, &size);
    RegCloseKey(k);
    if (r != ERROR_SUCCESS || type != REG_SZ || size == 0) return 0;
    out[(size < cap ? size : cap - 1)] = '\0';
    return out[0] != '\0';
}

/* Steam's install directory, by descending order of trustworthiness. */
static int steam_root(char *out, DWORD cap)
{
    /* ActiveProcess is written by a *running* client and holds a full path to
     * steamclient64.dll, so it settles both "where" and "is Steam even up".
     * The overlay lives in the same folder. */
    char dll[MAX_PATH];
    if (reg_string(HKEY_CURRENT_USER, "Software\\Valve\\Steam\\ActiveProcess",
                   "SteamClientDll64", 0, dll, sizeof dll)) {
        char *slash = strrchr(dll, '\\');
        if (slash) {
            *slash = '\0';
            strncpy(out, dll, cap - 1);
            out[cap - 1] = '\0';
            return 1;
        }
    }
    if (reg_string(HKEY_CURRENT_USER, "Software\\Valve\\Steam", "SteamPath", 0, out, cap))
        return 1;
    if (reg_string(HKEY_LOCAL_MACHINE, "SOFTWARE\\Valve\\Steam", "InstallPath",
                   KEY_WOW64_32KEY, out, cap))
        return 1;
    return 0;
}

static DWORD WINAPI overlay_thread(LPVOID unused)
{
    (void)unused;

    char flag[16];
    if (!config_value("steam_overlay", flag, sizeof flag) || flag[0] != '1') {
        olog("overlay: not enabled for this game");
        return 0;
    }

    /* Steam got there first — it launched the game after all. Loading it twice
     * would be harmless (the loader refcounts) but says something useful. */
    if (GetModuleHandleA(OVERLAY_DLL)) {
        olog("overlay: already present, nothing to do");
        return 0;
    }

    char root[MAX_PATH];
    if (!steam_root(root, sizeof root)) {
        olog("overlay: Steam's install path is not in the registry — is Steam installed?");
        return 0;
    }

    /* "e:/games/steam" is a real value read off a real machine. Normalise. */
    for (char *p = root; *p; p++) if (*p == '/') *p = '\\';
    size_t n = strlen(root);
    while (n && root[n - 1] == '\\') root[--n] = '\0';

    char path[MAX_PATH];
    snprintf(path, sizeof path, "%s\\%s", root, OVERLAY_DLL);

    if (GetFileAttributesA(path) == INVALID_FILE_ATTRIBUTES) {
        olog("overlay: not found at %s", path);
        return 0;
    }

    /*
     * The overlay asks the environment which game it is attached to. Steam sets
     * these when it launches a title; nothing has set them here. The session
     * belongs to Spacewar, so that is what it is told — the same 480 already in
     * steam_appid.txt, which is why a friends list reads "playing Spacewar"
     * with or without this.
     *
     * Only filled in if empty, so a game genuinely started by Steam keeps
     * Steam's own values.
     */
    char appid[16];
    if (!config_value("session_appid", appid, sizeof appid) || !appid[0])
        strcpy(appid, DEFAULT_APPID);

    char existing[16];
    if (!GetEnvironmentVariableA("SteamAppId", existing, sizeof existing))
        SetEnvironmentVariableA("SteamAppId", appid);
    if (!GetEnvironmentVariableA("SteamGameId", existing, sizeof existing))
        SetEnvironmentVariableA("SteamGameId", appid);

    /*
     * LOAD_WITH_ALTERED_SEARCH_PATH so its own dependencies resolve out of the
     * Steam folder rather than the game's — same trap the EOS proxy hits, in
     * the other direction.
     */
    HMODULE h = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (h) olog("overlay: loaded %s (app %s)", path, appid);
    else   olog("overlay: LoadLibraryEx failed for %s (err %lu)", path, GetLastError());
    return 0;
}

void librarian_overlay_init(librarian_log_fn log)
{
    g_log = log;
    /* Started, never joined: it is a few registry reads and a LoadLibrary, and
     * the process is entitled to outlive it. */
    HANDLE t = CreateThread(NULL, 0, overlay_thread, NULL, 0, NULL);
    if (t) CloseHandle(t);
}
