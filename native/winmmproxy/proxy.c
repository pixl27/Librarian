/*
 * winmm proxy — an early loading point, and nothing else.
 *
 * The Steam overlay attaches by hooking the game's graphics device the first
 * time it presents a frame. Steam installs that hook when it launches a game;
 * we launch the executable directly, so it never happens. Our other proxies can
 * load the overlay themselves, but only when the game first calls into
 * steam_api64 or the EOS SDK — and in a Unity game that is long after the D3D
 * device exists. The overlay renderer loads, finds the swapchain already built,
 * and gives up. Measured on PEAK: our LoadLibrary succeeded and Valve's renderer
 * wrote nothing, while Meccha (loaded early through EOS) attached and drew.
 *
 * winmm.dll is imported statically by UnityPlayer.dll and by a great many other
 * engines, so a copy in the game folder is mapped by the loader during process
 * start, before any of the game's own initialisation runs. That is early enough.
 * This proxy does one thing there: start the overlay loader. Every one of the
 * 180 winmm entry points is a forwarder to winmm_o.dll — our copy of the genuine
 * System32 library — so the multimedia timers, joystick and audio the game
 * actually uses reach the real implementation untouched.
 *
 * It is deliberately generic: it names no game and contains no game logic. It is
 * the same "stand in front of a library, forward everything, do one thing extra"
 * shape as the Steam and EOS proxies, applied to the one library that loads
 * early enough to matter.
 */

#include <windows.h>
#include <string.h>

#include "../overlay/overlay.h"

#define REAL_LIB "winmm_o.dll"

static HMODULE g_real;

/*
 * Load the genuine winmm by ABSOLUTE path, from our own directory.
 *
 * A forwarder is resolved with the standard search order, which starts at the
 * executable's directory. That is usually where we sit too, but "usually" is
 * how the EOS proxy lost its first build — so this registers winmm_o under its
 * own name during attach, and every forwarder then finds it already present.
 */
static void load_real(void)
{
    if (g_real) return;
    char path[MAX_PATH];
    HMODULE self = NULL;
    GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                       | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCSTR)(void *)&load_real, &self);
    if (GetModuleFileNameA(self, path, MAX_PATH)) {
        char *slash = strrchr(path, '\\');
        if (slash) {
            slash[1] = '\0';
            strncat(path, REAL_LIB, MAX_PATH - strlen(path) - 1);
            g_real = LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
        }
    }
    if (!g_real) g_real = LoadLibraryA(REAL_LIB);   /* last resort: search path */
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        load_real();                  /* so forwarders never hit the search path */
        /* overlay.c reads librarian_online.ini beside THIS dll (the game root),
         * writes its own librarian_overlay.log, and only acts if steam_overlay=1.
         * It starts a thread and returns, so this stays safe inside DllMain. */
        librarian_overlay_init(NULL);
    }
    return TRUE;
}
