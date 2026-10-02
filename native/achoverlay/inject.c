/*
 * Load the achievement overlay into a game Librarian has just started.
 *
 * Why this exists: the overlay has to run inside the game's process to reach
 * its swap chain, and there is no shared entry point to reach it through. For
 * a game running the launcher's steam_api64 proxy there would be — the proxy
 * is already loaded and could call the overlay itself — but the games that
 * actually record achievements run Goldberg, where steam_api64.dll *is* the
 * emulator and there is nothing of ours in the process at all.
 *
 * So the loader comes from outside: open the process, write the DLL path into
 * it, and start a thread on LoadLibraryA. kernel32 sits at the same address in
 * every process on a given boot, so the address resolved here is the address
 * over there — which is what makes the one-argument call possible without any
 * shellcode.
 *
 * Deliberately a separate executable rather than something the launcher does
 * itself: Node cannot call these APIs, and a 60-line program that does one
 * thing is easier to reason about than a native addon in the launcher.
 *
 *   librarian_inject.exe <pid> <path\to\dll>
 *
 * Exit codes are distinct so the caller can log something useful rather than
 * "it did not work".
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

enum {
    OK = 0,
    BAD_ARGS = 1,
    NO_PROCESS = 2,       /* the game exited, or is elevated beyond us */
    WRONG_ARCH = 3,       /* 32-bit game: the overlay is x64 only */
    NO_MEMORY = 4,
    NO_THREAD = 5,
    LOAD_FAILED = 6,      /* the remote LoadLibrary returned NULL */
};

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: librarian_inject <pid> <dll>\n");
        return BAD_ARGS;
    }

    const DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
    const char *dll = argv[2];

    char full[MAX_PATH];
    if (!GetFullPathNameA(dll, MAX_PATH, full, NULL)) return BAD_ARGS;
    if (GetFileAttributesA(full) == INVALID_FILE_ATTRIBUTES) {
        fprintf(stderr, "no such dll: %s\n", full);
        return BAD_ARGS;
    }

    HANDLE proc = OpenProcess(
        PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
        PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
        FALSE, pid);
    if (!proc) {
        fprintf(stderr, "OpenProcess failed: %lu\n", GetLastError());
        return NO_PROCESS;
    }

    /* A 32-bit game cannot load a 64-bit overlay, and saying so is better than
     * a remote LoadLibrary that fails for reasons nobody can see. */
    BOOL wow64 = FALSE;
    if (IsWow64Process(proc, &wow64) && wow64) {
        CloseHandle(proc);
        fprintf(stderr, "target is 32-bit; the overlay is x64 only\n");
        return WRONG_ARCH;
    }

    const SIZE_T bytes = strlen(full) + 1;
    void *remote = VirtualAllocEx(proc, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        CloseHandle(proc);
        fprintf(stderr, "VirtualAllocEx failed: %lu\n", GetLastError());
        return NO_MEMORY;
    }

    if (!WriteProcessMemory(proc, remote, full, bytes, NULL)) {
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        fprintf(stderr, "WriteProcessMemory failed: %lu\n", GetLastError());
        return NO_MEMORY;
    }

    /* Same module, same base address, same boot — so this pointer is valid in
     * the target as it is here. */
    FARPROC loadLibrary = GetProcAddress(GetModuleHandleA("kernel32.dll"), "LoadLibraryA");
    HANDLE thread = CreateRemoteThread(proc, NULL, 0,
                                       (LPTHREAD_START_ROUTINE)loadLibrary, remote, 0, NULL);
    if (!thread) {
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        fprintf(stderr, "CreateRemoteThread failed: %lu\n", GetLastError());
        return NO_THREAD;
    }

    /* The overlay's own DllMain returns immediately — it starts a thread and
     * gets out of the loader lock — so this wait is short by construction. */
    WaitForSingleObject(thread, 10000);

    DWORD module = 0;
    GetExitCodeThread(thread, &module);

    CloseHandle(thread);
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    CloseHandle(proc);

    if (!module) {
        fprintf(stderr, "remote LoadLibrary returned NULL\n");
        return LOAD_FAILED;
    }
    printf("loaded\n");
    return OK;
}
