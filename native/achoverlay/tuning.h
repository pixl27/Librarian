/*
 * In-game tuning: render-queue cap, frame limiter, per-frame measurements.
 *
 * Lives in the same DLL as the achievement overlay because it needs the same
 * thing: to be inside the game, at Present. The overlay owns the hook; these
 * are the two calls it makes around the original Present.
 */
#ifndef LIBRARIAN_TUNING_H
#define LIBRARIAN_TUNING_H

#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi.h>

typedef void (*tuning_log_fn)(const char *fmt, ...);

/* Map the config file for this process. 1 when it exists and is ours. */
int  tuning_open(tuning_log_fn log);

/* Non-zero once tuning_open succeeded. */
int  tuning_active(void);

/* Around the original Present. Both are no-ops until tuning_open succeeded,
 * and both go inert for the session at the first fault. */
void tuning_before_present(IDXGISwapChain *chain, UINT flags);
void tuning_after_present(IDXGISwapChain *chain, UINT flags, HRESULT hr);

/* Which vtable entries the overlay managed to hook, for the stats header. */
void tuning_note_hooks(unsigned mask);
/* Publish why render features are unavailable, without installing any hook. */
void tuning_disable_overlay_conflict(void);

/* Hook ID3D12CommandQueue::ExecuteCommandLists, once d3d12.dll is in the
 * process. 0 means "not loaded yet, ask again"; 1 means done (or given up). */
int  tuning_hook_d3d12(void);

#endif /* LIBRARIAN_TUNING_H */
