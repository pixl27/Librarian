/*
 * In-game tuning — the part of Librarian that runs at Present.
 *
 * Two things a game cannot be asked to do for itself, and one measurement:
 *
 *   Render queue cap.  When the GPU is the bottleneck the CPU runs ahead, and
 *   DXGI lets it queue up to three finished frames. Every queued frame is a
 *   frame of delay between the mouse and the screen. Capping the queue means
 *   waiting, after each Present, until the GPU has finished rendering the
 *   *previous* frame before handing control back to the game — so exactly one
 *   frame is in flight while the next is built. "Ultra" waits for the frame
 *   just presented: nothing in flight, lowest latency, GPU idles while the CPU
 *   works. Where DXGI exposes a maximum frame latency (a D3D11 device, or a
 *   waitable chain) it is set to one as well.
 *
 *   How the wait knows the GPU is done: a fence. On D3D12 the game's own
 *   direct command queue signals it (the queue is caught by hooking
 *   ExecuteCommandLists — the last direct queue that executed work before a
 *   Present rendered the frame — which works however late this DLL arrived).
 *   On D3D11 the immediate context signals an ID3D11Fence (Direct3D 11.3,
 *   Windows 10 1703 and later). The signal is issued just *before* Present,
 *   behind the game's draw calls, so Present's own flush carries it with the
 *   frame and nothing of ours is ever submitted on its own — a marker
 *   submitted after Present queues behind the pending present and, on the
 *   drivers measured, stalled the game to the compositor's rate. Event
 *   queries were tried first and are gone for the same reason: asking one
 *   about the frame just presented blocked for the whole present interval.
 *
 *   Frame limiter.  Waiting *before* Present, with a high-resolution timer for
 *   the bulk and a short spin for the last stretch, so the frame the game just
 *   built is the newest possible one when it goes out. A cap a few frames under
 *   the refresh rate keeps a variable-refresh display inside its range and
 *   never lets the V-Sync queue fill. API-agnostic: it only needs Present.
 *
 *   Measurement.  Every frame writes one ring entry: the Present-to-Present
 *   interval, how long the game spent inside Present (blocked on a full
 *   queue) and outside it (its own CPU work), the two waits above, how many
 *   frames the GPU still had pending right after Present, and how long the
 *   frame took from Present to GPU completion. That last one is stamped by a
 *   watcher thread that sleeps on the fence and wakes the moment each frame's
 *   value lands, so it is exact to the event's wake-up latency in every mode,
 *   including with everything off — which is what makes a before/after
 *   comparison worth reading. Librarian reads the ring; the overlay draws
 *   none of it.
 *
 * Coverage: D3D11 and D3D12, through Present and Present1. Not Vulkan or
 * OpenGL — those never call Present, so nothing here sees their frames.
 *
 * The rule inherited from the overlay: the game must come out unchanged when
 * this is off, and a fault anywhere here disables tuning for the session rather
 * than trying again into a broken device. Every device call sits under an SEH
 * handler and the switch is a single word in the stats header.
 */
#include "tuning.h"
#include "tuning_shared.h"

#include <d3d11_4.h>
#include <d3d12.h>
#include <dxgi1_3.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

#ifndef CREATE_WAITABLE_TIMER_HIGH_RESOLUTION
#define CREATE_WAITABLE_TIMER_HIGH_RESOLUTION 0x00000002
#endif

/* Interface identifiers declared here rather than pulled from dxguid, so that
 * linking never depends on which SDK built this. d3d12.dll itself is reached
 * through GetProcAddress and only when the game already loaded it. */
static const GUID LIB_IID_ID3D11Device5 =
    { 0x8ffde202, 0xa0e7, 0x45df, { 0x9e, 0x01, 0xe8, 0x37, 0x80, 0x1b, 0x5e, 0xa0 } };
static const GUID LIB_IID_ID3D11DeviceContext4 =
    { 0x917600da, 0xf58c, 0x4c33, { 0x98, 0xd8, 0x3e, 0x15, 0xb3, 0x90, 0xfa, 0x24 } };
static const GUID LIB_IID_ID3D11Fence =
    { 0xaffde9d1, 0x1df7, 0x4bb7, { 0x8a, 0x34, 0x0f, 0x46, 0x25, 0x1d, 0xab, 0x80 } };
static const GUID LIB_IID_ID3D12Device =
    { 0x189819f1, 0x1db6, 0x4b57, { 0xbe, 0x54, 0x18, 0x21, 0x33, 0x9b, 0x85, 0xf7 } };
static const GUID LIB_IID_ID3D12CommandQueue =
    { 0x0ec870a6, 0x5d7e, 0x4c22, { 0x8c, 0xfc, 0x5b, 0xaa, 0xe0, 0x76, 0x16, 0xed } };
static const GUID LIB_IID_ID3D12Fence =
    { 0x0a753dcf, 0xc4d8, 0x4b91, { 0xad, 0xf6, 0xbe, 0x5a, 0x60, 0xd9, 0x5a, 0x76 } };

static tuning_log_fn g_log;
#define LOG(...) do { if (g_log) g_log(__VA_ARGS__); } while (0)

/* ── Files ────────────────────────────────────────────────────────*/
static HANDLE g_cfg_file = INVALID_HANDLE_VALUE;
static HANDLE g_cfg_map = NULL;
static const volatile librarian_tune_config_t *g_cfg = NULL;

static HANDLE g_stats_file = INVALID_HANDLE_VALUE;
static HANDLE g_stats_map = NULL;
static librarian_tune_stats_t *g_stats = NULL;

static unsigned g_hooks_pending = 0;

/* ── Timing ───────────────────────────────────────────────────────*/
static LARGE_INTEGER g_freq;
static HANDLE   g_timer = NULL;
static LONGLONG g_deadline = 0;        /* limiter: next allowed Present, QPC ticks */
static LONGLONG g_prev_present = 0;    /* QPC of the previous Present call */
static LONGLONG g_present_qpc = 0;     /* QPC of this Present call, set before it */
static LONGLONG g_after_prev = 0;      /* QPC when the previous after_present handed back to the game */
static float    g_limiter_ms = 0.0f;
static float    g_cpu_ms = 0.0f;

static volatile LONG g_busy = 0;       /* one thread at a time on either side of Present */

static float ticks_ms(LONGLONG ticks)
{
    return (float)((double)ticks * 1000.0 / (double)g_freq.QuadPart);
}

static LONGLONG ms_ticks(float ms)
{
    return (LONGLONG)((double)ms * (double)g_freq.QuadPart / 1000.0);
}

/* ── Rolling medians, for the just-in-time mode ───────────────────
 * The game's typical CPU time per frame and its typical frame period, over
 * the last 32 frames. Medians rather than means: one loading hitch must not
 * teach the scheduler that frames take a second. */
#define WINDOW 32
typedef struct { float v[WINDOW]; unsigned n, i; } window_t;
static window_t g_w_cpu, g_w_frame;

static void window_push(window_t *w, float v)
{
    w->v[w->i] = v;
    w->i = (w->i + 1) % WINDOW;
    if (w->n < WINDOW) w->n++;
}

static float window_median(const window_t *w)
{
    if (!w->n) return 0.0f;
    float s[WINDOW];
    memcpy(s, w->v, w->n * sizeof(float));
    for (unsigned a = 1; a < w->n; a++) {            /* insertion sort: 32 floats */
        float x = s[a]; unsigned b = a;
        while (b > 0 && s[b - 1] > x) { s[b] = s[b - 1]; b--; }
        s[b] = x;
    }
    return s[w->n / 2];
}

/* ── The fence, whichever API owns it ─────────────────────────────*/
/* One fence value per frame, monotonically increasing. Completed values are
 * read from the fence; completion *times* come from the watcher thread. */
static ID3D11Fence          *g_fence11 = NULL;
static ID3D11DeviceContext4 *g_ctx4 = NULL;
static ID3D12Fence          *g_fence12 = NULL;
static ID3D12CommandQueue   *g_q12 = NULL;                /* the queue the fence rides */
static ID3D12CommandQueue *volatile g_q12_seen = NULL;    /* last direct queue that executed work */

static UINT64 fence_completed(void)
{
    if (g_fence11) return ID3D11Fence_GetCompletedValue(g_fence11);
    if (g_fence12) return ID3D12Fence_GetCompletedValue(g_fence12);
    return ~0ULL;
}

static HRESULT fence_event(UINT64 value, HANDLE event)
{
    if (g_fence11) return ID3D11Fence_SetEventOnCompletion(g_fence11, value, event);
    if (g_fence12) return ID3D12Fence_SetEventOnCompletion(g_fence12, value, event);
    return E_FAIL;
}

static int have_backend(void) { return g_fence11 != NULL || (g_fence12 != NULL && g_q12 != NULL); }

/* ── Frames in flight ─────────────────────────────────────────────*/
#define INFLIGHT 16
typedef struct {
    UINT64   value;        /* fence value signalled for this frame */
    LONGLONG present_qpc;  /* when Present was called for it */
    LONGLONG first_seen;   /* first time it was checked, for the fallback estimate */
    uint32_t slot;         /* ring index of the frame */
    int      pending;
    int      frames_done;  /* frames since the fence said done, waiting for the watcher's stamp */
} inflight_t;

static inflight_t g_inflight[INFLIGHT];
static unsigned   g_next = 0;
static UINT64     g_value = 0;          /* last value signalled */

/* The watcher's stamps: value -> QPC at which it was seen complete. Written
 * by the watcher, read by the render thread; `value` last, so a torn read is
 * an old entry, never a wrong time. */
#define STAMPS 64
typedef struct { volatile UINT64 value; volatile LONGLONG qpc; } stamp_t;
static stamp_t g_stamps[STAMPS];

typedef struct { uint32_t slot; float lat_ms; uint16_t unc; } resolved_t;
static resolved_t g_parked[INFLIGHT];
static unsigned   g_nparked = 0;

/* ── The watcher ──────────────────────────────────────────────────*/
/* Sleeps on the fence for one value after another and writes down when each
 * one landed. Only the fence is touched from here — never a context, which
 * the game's render thread owns. Holds its own reference so a backend torn
 * down under it cannot take the fence away mid-wait. */
static HANDLE        g_watch_thread = NULL;
static HANDLE        g_watch_wake = NULL;     /* render thread: "a new value is out" */
static HANDLE        g_watch_done = NULL;     /* fence: "your value landed" */
static volatile LONG g_watch_stop = 0;
static volatile LONG g_watch_generation = 0;

typedef struct { IUnknown *fence; int is12; LONG generation; } watch_args_t;

static DWORD WINAPI watch_thread(LPVOID param)
{
    watch_args_t *a = (watch_args_t *)param;
    IUnknown *fence = a->fence;
    const int is12 = a->is12;
    const LONG generation = a->generation;
    HeapFree(GetProcessHeap(), 0, a);

    HANDLE done = CreateEventW(NULL, FALSE, FALSE, NULL);
    UINT64 next = 1;
    while (!g_watch_stop && g_watch_generation == generation && done) {
        UINT64 latest = g_value;
        if (next > latest) { WaitForSingleObject(g_watch_wake, 50); continue; }
        UINT64 completed = is12 ? ID3D12Fence_GetCompletedValue((ID3D12Fence *)fence)
                                : ID3D11Fence_GetCompletedValue((ID3D11Fence *)fence);
        if (completed == ~0ULL) break;                          /* device removed */
        if (completed < next) {
            HRESULT hr = is12 ? ID3D12Fence_SetEventOnCompletion((ID3D12Fence *)fence, next, done)
                              : ID3D11Fence_SetEventOnCompletion((ID3D11Fence *)fence, next, done);
            if (FAILED(hr)) break;
            if (WaitForSingleObject(done, 2000) != WAIT_OBJECT_0) continue;   /* look again */
        }
        LARGE_INTEGER now;
        QueryPerformanceCounter(&now);
        /* Values that landed together get the same stamp; the fence only says
         * "at least this far", so everything up to `completed` is done now. */
        completed = is12 ? ID3D12Fence_GetCompletedValue((ID3D12Fence *)fence)
                         : ID3D11Fence_GetCompletedValue((ID3D11Fence *)fence);
        if (completed == ~0ULL) break;
        for (; next <= completed && next <= latest; next++) {
            stamp_t *s = &g_stamps[next % STAMPS];
            s->qpc = now.QuadPart;
            MemoryBarrier();
            s->value = next;
        }
    }
    if (done) CloseHandle(done);
    IUnknown_Release(fence);
    return 0;
}

static void watcher_stop(void)
{
    InterlockedIncrement(&g_watch_generation);
    if (g_watch_wake) SetEvent(g_watch_wake);
    if (g_watch_thread) { CloseHandle(g_watch_thread); g_watch_thread = NULL; }   /* it exits on its own */
}

static void watcher_start(IUnknown *fence, int is12)
{
    if (!g_watch_wake) g_watch_wake = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!g_watch_done) g_watch_done = CreateEventW(NULL, FALSE, FALSE, NULL);
    watch_args_t *a = (watch_args_t *)HeapAlloc(GetProcessHeap(), 0, sizeof *a);
    if (!a) return;
    IUnknown_AddRef(fence);
    a->fence = fence; a->is12 = is12; a->generation = g_watch_generation;
    memset(g_stamps, 0, sizeof g_stamps);
    g_watch_thread = CreateThread(NULL, 0, watch_thread, a, 0, NULL);
    if (!g_watch_thread) { IUnknown_Release(fence); HeapFree(GetProcessHeap(), 0, a); }
}

/* ── Backends ─────────────────────────────────────────────────────*/
static IDXGISwapChain  *g_chain = NULL;
static int              g_probed = 0;
static unsigned         g_reprobe = 0;
static IDXGISwapChain2 *g_chain2 = NULL;     /* only when the chain is waitable */
static ID3D11Device    *g_dev = NULL;
static IDXGIDevice1    *g_dxgidev = NULL;
static int              g_cap_applied = 0;
static UINT             g_prev_latency_dev = 0;
static UINT             g_prev_latency_chain = 0;
static unsigned         g_timeouts = 0;
static int              g_hook12_done = 0;

static void release_backend(void)
{
    watcher_stop();
    for (int i = 0; i < INFLIGHT; i++) g_inflight[i].pending = 0;
    if (g_chain2)  { IDXGISwapChain2_Release(g_chain2);       g_chain2 = NULL; }
    if (g_dxgidev) { IDXGIDevice1_Release(g_dxgidev);         g_dxgidev = NULL; }
    if (g_ctx4)    { ID3D11DeviceContext4_Release(g_ctx4);    g_ctx4 = NULL; }
    if (g_fence11) { ID3D11Fence_Release(g_fence11);          g_fence11 = NULL; }
    if (g_dev)     { ID3D11Device_Release(g_dev);             g_dev = NULL; }
    if (g_fence12) { ID3D12Fence_Release(g_fence12);          g_fence12 = NULL; }
    g_q12 = NULL;                       /* seen queues are never released: see hooked_execute */
    g_cap_applied = 0;
    g_next = 0;
    g_nparked = 0;
}

static void give_up(uint32_t reason)
{
    if (g_stats && !g_stats->disabled) {
        g_stats->disabled = reason;
        g_stats->applied_flags = 0;
    }
    LOG("[tuning] disabled for the session (reason %u)", reason);
}

void tuning_disable_overlay_conflict(void)
{
    if (g_stats) g_stats->caps = 0;
    give_up(LIBRARIAN_TUNE_OFF_OVERLAY);
}

/* Remember the chain's own latency control when it has one. A waitable chain
 * ignores the device-level setting, so this is the one that counts there. */
static void adopt_chain(IDXGISwapChain *chain)
{
    if (g_chain2) { IDXGISwapChain2_Release(g_chain2); g_chain2 = NULL; }
    IDXGISwapChain2 *c2 = NULL;
    if (SUCCEEDED(IDXGISwapChain_QueryInterface(chain, &IID_IDXGISwapChain2, (void **)&c2)) && c2) {
        DXGI_SWAP_CHAIN_DESC desc;
        if (SUCCEEDED(IDXGISwapChain_GetDesc(chain, &desc)) &&
            (desc.Flags & DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT)) {
            g_chain2 = c2;
        } else {
            IDXGISwapChain2_Release(c2);
        }
    }
    g_cap_applied = 0;                  /* chain-level latency must be re-applied */
}

static int setup_d3d11(ID3D11Device *dev)
{
    release_backend();
    g_stats->stage = LIBRARIAN_TUNE_STAGE_FENCE;
    g_dev = dev;                                   /* takes the caller's reference */
    g_stats->device_flags = ID3D11Device_GetCreationFlags(g_dev);
    if (g_stats->device_flags & D3D11_CREATE_DEVICE_SINGLETHREADED)
        LOG("[tuning] device is D3D11_CREATE_DEVICE_SINGLETHREADED (flags 0x%X)", g_stats->device_flags);
    if (FAILED(ID3D11Device_QueryInterface(g_dev, &IID_IDXGIDevice1, (void **)&g_dxgidev))) g_dxgidev = NULL;

    ID3D11Device5 *dev5 = NULL;
    ID3D11DeviceContext *ctx = NULL;
    ID3D11Device_GetImmediateContext(g_dev, &ctx);
    if (SUCCEEDED(ID3D11Device_QueryInterface(g_dev, &LIB_IID_ID3D11Device5, (void **)&dev5)) && dev5 && ctx) {
        if (SUCCEEDED(ID3D11DeviceContext_QueryInterface(ctx, &LIB_IID_ID3D11DeviceContext4, (void **)&g_ctx4)) && g_ctx4) {
            HRESULT hr = ID3D11Device5_CreateFence(dev5, 0, D3D11_FENCE_FLAG_NONE, &LIB_IID_ID3D11Fence, (void **)&g_fence11);
            if (FAILED(hr)) { LOG("[tuning] CreateFence (D3D11) failed 0x%08lX; queue cap unavailable", hr); g_fence11 = NULL; }
        } else {
            LOG("[tuning] no ID3D11DeviceContext4; queue cap unavailable");
        }
    } else {
        LOG("[tuning] no ID3D11Device5 (Windows 10 1703 or later needed); queue cap unavailable");
    }
    if (dev5) ID3D11Device5_Release(dev5);
    if (ctx) ID3D11DeviceContext_Release(ctx);
    if (!g_fence11) { if (g_ctx4) { ID3D11DeviceContext4_Release(g_ctx4); g_ctx4 = NULL; } return 0; }
    g_value = 0;
    watcher_start((IUnknown *)g_fence11, 0);
    return 1;
}

static int setup_d3d12(ID3D12CommandQueue *queue)
{
    release_backend();
    ID3D12Device *dev = NULL;
    if (FAILED(ID3D12CommandQueue_GetDevice(queue, &LIB_IID_ID3D12Device, (void **)&dev)) || !dev) return 0;
    HRESULT hr = ID3D12Device_CreateFence(dev, 0, D3D12_FENCE_FLAG_NONE, &LIB_IID_ID3D12Fence, (void **)&g_fence12);
    ID3D12Device_Release(dev);
    if (FAILED(hr) || !g_fence12) { LOG("[tuning] CreateFence (D3D12) failed 0x%08lX; queue cap unavailable", hr); g_fence12 = NULL; return 0; }
    g_q12 = queue;
    g_value = 0;
    watcher_start((IUnknown *)g_fence12, 1);
    return 1;
}

/* The chain changed, or nothing has been looked at yet. Find out what is
 * behind it, and build what the queue cap needs. */
static void ensure_backend(IDXGISwapChain *chain)
{
    if (chain == g_chain && g_probed) {
        /* A D3D12 chain whose queue had not executed anything yet: look again
         * now and then, cheaply. */
        if (!have_backend() && g_stats->api == LIBRARIAN_TUNE_API_D3D12 && g_q12_seen && ++g_reprobe >= 30) g_reprobe = 0;
        else return;
    }

    ID3D11Device *dev11 = NULL;
    HRESULT hr = IDXGISwapChain_GetDevice(chain, &IID_ID3D11Device, (void **)&dev11);
    if (SUCCEEDED(hr) && dev11) {
        if (dev11 == g_dev) ID3D11Device_Release(dev11);          /* same device, new chain */
        else setup_d3d11(dev11);
        g_stats->api = LIBRARIAN_TUNE_API_D3D11;
        if (chain != g_chain) adopt_chain(chain);
        if (g_fence11) g_stats->caps |= LIBRARIAN_TUNE_CAN_QUEUE; else g_stats->caps &= ~LIBRARIAN_TUNE_CAN_QUEUE;
        LOG("[tuning] D3D11 chain %p (waitable %d, fence %d)", (void *)chain, g_chain2 != NULL, g_fence11 != NULL);
    } else {
        /* Not D3D11. The queue comes from the ExecuteCommandLists hook; some
         * runtimes also answer GetDevice with it, which is worth one try. */
        ID3D12CommandQueue *q = g_q12_seen;
        if (!q) {
            void *via = NULL;
            if (SUCCEEDED(IDXGISwapChain_GetDevice(chain, &LIB_IID_ID3D12CommandQueue, &via)) && via) q = (ID3D12CommandQueue *)via;
        }
        int is12 = q != NULL;
        if (!is12) {
            void *d12 = NULL;
            if (SUCCEEDED(IDXGISwapChain_GetDevice(chain, &LIB_IID_ID3D12Device, &d12)) && d12) { IUnknown_Release((IUnknown *)d12); is12 = 1; }
            else if (GetModuleHandleA("d3d12.dll")) is12 = 1;    /* the runtime is in the process and the chain is not D3D11 */
        }
        if (q && q != g_q12) {
            if (setup_d3d12(q)) LOG("[tuning] D3D12 chain %p on queue %p", (void *)chain, (void *)q);
        } else if (!q) {
            release_backend();
        }
        if (chain != g_chain) adopt_chain(chain);
        g_stats->api = is12 ? LIBRARIAN_TUNE_API_D3D12 : LIBRARIAN_TUNE_API_UNKNOWN;
        if (g_q12 && g_fence12) g_stats->caps |= LIBRARIAN_TUNE_CAN_QUEUE; else g_stats->caps &= ~LIBRARIAN_TUNE_CAN_QUEUE;
        if (!q) LOG("[tuning] chain %p: %s, no command queue seen yet (0x%08lX)", (void *)chain, is12 ? "D3D12" : "unknown API", hr);
    }
    g_chain = chain;
    g_probed = 1;
}

/*
 * The DXGI maximum frame latency, on top of the fence wait — but only where
 * it is ours to set. A *waitable* chain (Unity, Unreal) is different: the
 * game itself blocks on the chain's waitable object every frame, and that
 * object is a semaphore whose count the latency setting governs. Changing it
 * under a game that is mid-wait is a stall or a deadlock waiting to happen
 * (measured on ULTRAKILL: ten seconds without a single Present after the
 * cap was switched live). So on a waitable chain nothing is touched, and the
 * fence wait carries the cap alone; on a plain chain the device-level value
 * goes to one and comes back, which no game code ever waits on directly.
 */
static void apply_cap(uint32_t cf)
{
    const int want = (cf & LIBRARIAN_TUNE_QUEUE_CAP) != 0;
    if (want && !g_cap_applied) {
        if (g_dxgidev && !g_chain2) {
            UINT prev = 0;
            if (SUCCEEDED(IDXGIDevice1_GetMaximumFrameLatency(g_dxgidev, &prev))) g_prev_latency_dev = prev;
            IDXGIDevice1_SetMaximumFrameLatency(g_dxgidev, 1);
            g_stats->max_latency_prev = prev;
        } else if (g_chain2) {
            UINT prev = 0;
            if (SUCCEEDED(IDXGISwapChain2_GetMaximumFrameLatency(g_chain2, &prev))) g_stats->max_latency_prev = prev;
        }
        g_cap_applied = 1;
        LOG("[tuning] render queue capped (%s, DXGI latency was %u)", g_chain2 ? "waitable chain: fence only" : "device latency 1", g_stats->max_latency_prev);
    } else if (!want && g_cap_applied) {
        if (g_dxgidev && !g_chain2) IDXGIDevice1_SetMaximumFrameLatency(g_dxgidev, g_prev_latency_dev ? g_prev_latency_dev : 3);
        g_cap_applied = 0;
        LOG("[tuning] render queue cap released");
    }
}

static void park(uint32_t slot, float lat_ms, uint16_t unc)
{
    if (g_nparked < INFLIGHT) { g_parked[g_nparked].slot = slot; g_parked[g_nparked].lat_ms = lat_ms; g_parked[g_nparked].unc = unc; g_nparked++; }
}

/* Settle every frame the fence says is done: with the watcher's stamp when it
 * has one (exact), or with an estimate after a few frames without one. The
 * count of frames still not done is the render queue depth. */
static unsigned sweep(LONGLONG now)
{
    const UINT64 completed = fence_completed();
    unsigned pending = 0;
    for (int i = 0; i < INFLIGHT; i++) {
        inflight_t *f = &g_inflight[i];
        if (!f->pending) continue;
        if (completed == ~0ULL) { f->pending = 0; continue; }         /* device removed */
        if (f->value > completed) { pending++; continue; }

        const stamp_t *s = &g_stamps[f->value % STAMPS];
        if (s->value == f->value) {
            float lat = ticks_ms(s->qpc - f->present_qpc);
            park(f->slot, lat < 0.0f ? 0.0f : lat, 1);              /* to about a tenth of a millisecond */
            f->pending = 0;
        } else if (++f->frames_done >= 3) {
            /* The watcher never stamped it (starved, or gone): somewhere
             * between when it was first checked and now. */
            const LONGLONG lo = f->first_seen > f->present_qpc ? f->first_seen : f->present_qpc;
            const float width = ticks_ms(now - lo);
            const float mid = ticks_ms((lo + now) / 2 - f->present_qpc);
            const float tenths = width * 10.0f;
            park(f->slot, mid < 0.0f ? 0.0f : mid, tenths >= 65535.0f ? 65534 : (uint16_t)tenths);
            f->pending = 0;
        }
        /* else: done on the GPU, stamp on its way; not pending, not settled */
    }
    return pending;
}

/* Block until the fence has passed `target`. A short spin first — the value
 * is usually a few hundred microseconds away — then the event, bounded: a GPU
 * that does not answer within a quarter second is not something to wait on. */
static float wait_fence(UINT64 target)
{
    LARGE_INTEGER t0, now;
    QueryPerformanceCounter(&t0);
    for (;;) {
        if (fence_completed() >= target) break;
        QueryPerformanceCounter(&now);
        if (ticks_ms(now.QuadPart - t0.QuadPart) > 0.3f) {
            if (SUCCEEDED(fence_event(target, g_watch_done)) && WaitForSingleObject(g_watch_done, 250) == WAIT_OBJECT_0) {
                g_timeouts = 0;
            } else {
                g_stats->errors++;
                if (++g_timeouts >= 5) give_up(LIBRARIAN_TUNE_OFF_GPU_HANG);
            }
            break;
        }
        YieldProcessor();
    }
    QueryPerformanceCounter(&now);
    return ticks_ms(now.QuadPart - t0.QuadPart);
}

/* ── D3D12: catching the game's command queue ─────────────────────*/
typedef void (STDMETHODCALLTYPE *execute_fn)(ID3D12CommandQueue *, UINT, ID3D12CommandList *const *);
static execute_fn g_execute_original = NULL;

static void STDMETHODCALLTYPE hooked_execute(ID3D12CommandQueue *queue, UINT count, ID3D12CommandList *const *lists)
{
    if (queue != g_q12_seen) {
        D3D12_COMMAND_QUEUE_DESC desc;
        /* Direct queues render and present; compute and copy queues do not.
         * GetDesc returns the struct by value through a hidden pointer in the
         * C binding. */
        D3D12_COMMAND_QUEUE_DESC *d = ID3D12CommandQueue_GetDesc(queue, &desc);
        if (d && d->Type == D3D12_COMMAND_LIST_TYPE_DIRECT) {
            /* Held for the life of the process and never released: the Present
             * thread may be using it the instant it is replaced, and a queue is
             * a long-lived object a game keeps anyway. */
            ID3D12CommandQueue_AddRef(queue);
            InterlockedExchangePointer((void *volatile *)&g_q12_seen, queue);
        }
    }
    g_execute_original(queue, count, lists);
}

typedef HRESULT (WINAPI *create_device12_fn)(IUnknown *, D3D_FEATURE_LEVEL, REFIID, void **);

/* Hook ID3D12CommandQueue::ExecuteCommandLists through a throwaway device and
 * queue: d3d12.dll has one queue class, so their vtable is the game's too.
 * Only once the game itself has loaded the runtime — a D3D11 game should not
 * have D3D12 pulled into it for a probe it will never need. */
int tuning_hook_d3d12(void)
{
    if (g_hook12_done) return 1;
    HMODULE d3d12 = GetModuleHandleA("d3d12.dll");
    if (!d3d12) return 0;
    create_device12_fn create = (create_device12_fn)GetProcAddress(d3d12, "D3D12CreateDevice");
    if (!create) { g_hook12_done = 1; return 1; }

    ID3D12Device *dev = NULL;
    if (FAILED(create(NULL, D3D_FEATURE_LEVEL_11_0, &LIB_IID_ID3D12Device, (void **)&dev)) || !dev) {
        LOG("[tuning] D3D12 probe device failed; D3D12 queue cap unavailable");
        g_hook12_done = 1;
        return 1;
    }
    D3D12_COMMAND_QUEUE_DESC qd = { D3D12_COMMAND_LIST_TYPE_DIRECT, 0, D3D12_COMMAND_QUEUE_FLAG_NONE, 0 };
    ID3D12CommandQueue *queue = NULL;
    if (SUCCEEDED(ID3D12Device_CreateCommandQueue(dev, &qd, &LIB_IID_ID3D12CommandQueue, (void **)&queue)) && queue) {
        void **vtable = *(void ***)queue;
        DWORD old;
        if (VirtualProtect(&vtable[10], sizeof(void *), PAGE_EXECUTE_READWRITE, &old)) {
            g_execute_original = (execute_fn)vtable[10];   /* ID3D12CommandQueue::ExecuteCommandLists */
            vtable[10] = (void *)hooked_execute;
            VirtualProtect(&vtable[10], sizeof(void *), old, &old);
            if (g_stats) g_stats->hooks |= 4;
            g_hooks_pending |= 4;
            LOG("[tuning] ExecuteCommandLists hooked at %p", (void *)g_execute_original);
        }
        ID3D12CommandQueue_Release(queue);
    }
    ID3D12Device_Release(dev);
    g_hook12_done = 1;
    return 1;
}

/* ── Limiter ──────────────────────────────────────────────────────*/
static void wait_until(LONGLONG target)
{
    LARGE_INTEGER now;
    for (;;) {
        QueryPerformanceCounter(&now);
        const LONGLONG remaining = target - now.QuadPart;
        if (remaining <= 0) return;
        const float ms = ticks_ms(remaining);
        if (ms > 1.2f && g_timer) {
            /* Sleep for most of it, leave the last stretch to the spin. The
             * timer is relative, in 100 ns units, negative for "from now". */
            LARGE_INTEGER due;
            due.QuadPart = -(LONGLONG)((ms - 0.8f) * 10000.0f);
            if (SetWaitableTimer(g_timer, &due, 0, NULL, NULL, FALSE)) WaitForSingleObject(g_timer, 100);
            else Sleep(1);
            continue;
        }
        if (ms > 2.5f) { Sleep(1); continue; }
        YieldProcessor();
    }
}

/* ── Public ───────────────────────────────────────────────────────*/
static int tuning_dir(char *out, size_t cap)
{
    char local[MAX_PATH];
    if (!GetEnvironmentVariableA("LOCALAPPDATA", local, MAX_PATH)) return 0;
    if (_snprintf(out, cap, "%s\\Librarian\\tuning", local) < 0) return 0;
    return 1;
}

void tuning_note_hooks(unsigned mask)
{
    g_hooks_pending |= mask;
    if (g_stats) g_stats->hooks = g_hooks_pending;
}

int tuning_active(void) { return g_cfg != NULL && g_stats != NULL; }

int tuning_open(tuning_log_fn log)
{
    g_log = log;
    if (g_cfg) return 1;

    char dir[MAX_PATH], path[MAX_PATH];
    if (!tuning_dir(dir, sizeof dir)) return 0;
    if (_snprintf(path, sizeof path, "%s\\%lu.cfg", dir, GetCurrentProcessId()) < 0) return 0;

    HANDLE f = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return 0;          /* Librarian did not ask for tuning */

    HANDLE m = CreateFileMappingA(f, NULL, PAGE_READONLY, 0, sizeof(librarian_tune_config_t), NULL);
    if (!m) { CloseHandle(f); return 0; }
    const volatile librarian_tune_config_t *cfg =
        (const volatile librarian_tune_config_t *)MapViewOfFile(m, FILE_MAP_READ, 0, 0, sizeof(librarian_tune_config_t));
    if (!cfg) { CloseHandle(m); CloseHandle(f); return 0; }

    if (cfg->magic != LIBRARIAN_TUNE_MAGIC || cfg->version != LIBRARIAN_TUNE_VERSION) {
        LOG("[tuning] config has magic %08X version %u; expected %08X/%u — tuning stays off",
            cfg->magic, cfg->version, LIBRARIAN_TUNE_MAGIC, LIBRARIAN_TUNE_VERSION);
        UnmapViewOfFile((LPCVOID)cfg); CloseHandle(m); CloseHandle(f);
        return 0;
    }

    /* The stats file is ours to create. Without it Librarian could not show
     * what is happening, so a failure here keeps tuning off rather than
     * applying changes nobody can see. */
    if (_snprintf(path, sizeof path, "%s\\%lu.stats", dir, GetCurrentProcessId()) < 0) goto fail;
    HANDLE s = CreateFileA(path, GENERIC_READ | GENERIC_WRITE,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (s == INVALID_HANDLE_VALUE) {
        LOG("[tuning] cannot create %s (error %lu); tuning stays off", path, GetLastError());
        goto fail;
    }
    HANDLE sm = CreateFileMappingA(s, NULL, PAGE_READWRITE, 0, sizeof(librarian_tune_stats_t), NULL);
    if (!sm) { LOG("[tuning] stats mapping failed (%lu)", GetLastError()); CloseHandle(s); goto fail; }
    librarian_tune_stats_t *stats =
        (librarian_tune_stats_t *)MapViewOfFile(sm, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(librarian_tune_stats_t));
    if (!stats) { LOG("[tuning] stats view failed (%lu)", GetLastError()); CloseHandle(sm); CloseHandle(s); goto fail; }

    /* A fresh mapping is zero-filled; only the header needs values. */
    stats->version = LIBRARIAN_TUNE_VERSION;
    stats->api = LIBRARIAN_TUNE_API_UNKNOWN;
    stats->caps = LIBRARIAN_TUNE_CAN_LIMIT;
    stats->hooks = g_hooks_pending;
    MemoryBarrier();
    stats->magic = LIBRARIAN_TUNE_STATS_MAGIC;   /* last: the reader keys on it */

    QueryPerformanceFrequency(&g_freq);
    g_timer = CreateWaitableTimerExW(NULL, NULL, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!g_timer) g_timer = CreateWaitableTimerExW(NULL, NULL, 0, TIMER_ALL_ACCESS);

    g_cfg_file = f; g_cfg_map = m; g_cfg = cfg;
    g_stats_file = s; g_stats_map = sm; g_stats = stats;
    LOG("[tuning] on: flags %u, fps %.1f, high-res timer %d", cfg->flags, cfg->fps_limit, g_timer != NULL);
    return 1;

fail:
    UnmapViewOfFile((LPCVOID)cfg); CloseHandle(m); CloseHandle(f);
    return 0;
}

/* LIBRARIAN_TUNE_TRACE=1 in the game's environment logs one line every 64
 * frames with where the time went. For finding a stall nobody accounted for. */
static int   g_trace = -1;
static float g_t_after = 0.0f;

static void trace_frame(float frame_ms, float present_ms, float gpu_wait)
{
    if (g_trace < 0) { char v[8] = ""; g_trace = GetEnvironmentVariableA("LIBRARIAN_TUNE_TRACE", v, sizeof v) > 0 && v[0] == '1'; }
    if (!g_trace || (g_stats->frames & 63) != 0) return;
    LOG("[tuning] f%u frame %.2f = cpu %.2f + limiter %.2f + present %.2f + after %.2f (gpu wait %.2f)",
        g_stats->frames, frame_ms, g_cpu_ms, g_limiter_ms, present_ms, g_t_after, gpu_wait);
}

static void before_present_body(void)
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    g_stats->stage = LIBRARIAN_TUNE_STAGE_BEFORE;
    g_limiter_ms = 0.0f;
    g_cpu_ms = g_after_prev ? ticks_ms(now.QuadPart - g_after_prev) : 0.0f;

    const uint32_t cf = g_cfg->flags;
    const float fps = g_cfg->fps_limit;
    if ((cf & LIBRARIAN_TUNE_LIMITER) && fps > 1.0f && fps < 10000.0f) {
        const LONGLONG period = (LONGLONG)((double)g_freq.QuadPart / (double)fps);
        if (g_deadline == 0) g_deadline = now.QuadPart;         /* first limited frame: no wait */
        if (now.QuadPart < g_deadline) {
            const LONGLONG start = now.QuadPart;
            wait_until(g_deadline);
            QueryPerformanceCounter(&now);
            g_limiter_ms = ticks_ms(now.QuadPart - start);
        }
        g_deadline += period;
        if (now.QuadPart > g_deadline) g_deadline = now.QuadPart;  /* slower than the cap: no debt */
    } else {
        g_deadline = 0;
    }
    g_present_qpc = now.QuadPart;

    /* This frame's fence value, signalled behind the game's draw calls and
     * ahead of Present so that Present's flush carries it with the frame. */
    if (have_backend()) {
        g_stats->stage = LIBRARIAN_TUNE_STAGE_SIGNAL;
        inflight_t *me = &g_inflight[g_next % INFLIGHT];
        me->pending = 0;                       /* sixteen frames unresolved: forget it */
        const UINT64 value = g_value + 1;
        HRESULT hr;
        if (g_fence11) hr = ID3D11DeviceContext4_Signal(g_ctx4, g_fence11, value);
        else hr = ID3D12CommandQueue_Signal(g_q12, g_fence12, value);
        if (SUCCEEDED(hr)) {
            g_value = value;
            me->value = value;
            me->present_qpc = now.QuadPart;
            me->first_seen = now.QuadPart;
            me->slot = g_stats->frames % LIBRARIAN_TUNE_RING;
            me->frames_done = 0;
            me->pending = 1;
            g_next++;
            SetEvent(g_watch_wake);
        } else if (++g_stats->errors > 50) {
            give_up(LIBRARIAN_TUNE_OFF_ERRORS);
        }
    }
    g_stats->stage = LIBRARIAN_TUNE_STAGE_PRESENT;
}

void tuning_before_present(IDXGISwapChain *chain, UINT flags)
{
    (void)chain;
    if (!g_cfg || !g_stats || g_stats->disabled) return;
    if (flags & DXGI_PRESENT_TEST) return;
    if (InterlockedCompareExchange(&g_busy, 1, 0)) return;
    __try {
        before_present_body();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        give_up(LIBRARIAN_TUNE_OFF_EXCEPTION);
    }
    g_busy = 0;
}

static void after_present_body(IDXGISwapChain *chain, HRESULT hr)
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);

    const float frame_ms = g_prev_present ? ticks_ms(g_present_qpc - g_prev_present) : 0.0f;
    const float present_ms = ticks_ms(now.QuadPart - g_present_qpc);
    g_prev_present = g_present_qpc;

    const uint32_t cf = g_cfg->flags;
    const float fps = g_cfg->fps_limit;
    uint32_t applied = 0;
    if ((cf & LIBRARIAN_TUNE_LIMITER) && fps > 1.0f && fps < 10000.0f) applied |= LIBRARIAN_TUNE_LIMITER;

    unsigned depth = 0;
    float gpu_wait = 0.0f;

    if (FAILED(hr)) {
        /* The device is gone or the game is recreating its chain; let go of
         * everything and look again on the next successful Present. */
        if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) { release_backend(); g_probed = 0; }
        g_stats->errors++;
    } else {
        g_stats->stage = LIBRARIAN_TUNE_STAGE_PROBE;
        ensure_backend(chain);
        if (have_backend()) {
            const int jit = (cf & LIBRARIAN_TUNE_QUEUE_AUTO) != 0;
            /* Just-in-time leaves DXGI's own latency alone; only the fixed
             * caps ask for it. */
            g_stats->stage = LIBRARIAN_TUNE_STAGE_CAP;
            apply_cap(jit ? (cf & ~LIBRARIAN_TUNE_QUEUE_CAP) : cf);
            if (!jit && (g_cap_applied || ((cf & LIBRARIAN_TUNE_QUEUE_CAP) && !g_dxgidev && !g_chain2)))
                applied |= LIBRARIAN_TUNE_QUEUE_CAP | (cf & LIBRARIAN_TUNE_QUEUE_ULTRA);

            /* What the GPU still has, the instant Present handed back. */
            g_stats->stage = LIBRARIAN_TUNE_STAGE_SWEEP;
            depth = sweep(now.QuadPart);
            g_stats->stage = LIBRARIAN_TUNE_STAGE_WAIT;

            if (jit && g_value > 1) {
                /*
                 * Just in time. The GPU finished the previous frame at c_prev
                 * and, being the bottleneck, will finish this one about one
                 * frame period later. The game's next frame takes cpu_med of
                 * CPU work; started at c_prev + period - cpu_med - margin it
                 * reaches Present just as the GPU frees up: no blocking in
                 * Present, no idle GPU, and the input sampled that much later.
                 * When the CPU is the bottleneck the target is already in the
                 * past and nothing happens — which is the point.
                 */
                applied |= LIBRARIAN_TUNE_QUEUE_AUTO;
                const UINT64 prev = g_value - 1;
                LARGE_INTEGER t;
                if (fence_completed() < prev) {
                    gpu_wait += wait_fence(prev);
                    QueryPerformanceCounter(&t);
                    sweep(t.QuadPart);
                }
                QueryPerformanceCounter(&t);
                const stamp_t *s = &g_stamps[prev % STAMPS];
                const LONGLONG c_prev = (s->value == prev) ? s->qpc : t.QuadPart;
                const float frame_med = window_median(&g_w_frame);
                const float cpu_med = window_median(&g_w_cpu);
                if (g_w_frame.n >= 8 && frame_med > 0.0f) {
                    float margin = frame_med * 0.08f;
                    if (margin < 0.3f) margin = 0.3f;
                    const LONGLONG target_t = c_prev + ms_ticks(frame_med - cpu_med - margin);
                    if (target_t > t.QuadPart) {
                        wait_until(target_t);
                        LARGE_INTEGER t2;
                        QueryPerformanceCounter(&t2);
                        gpu_wait += ticks_ms(t2.QuadPart - t.QuadPart);
                        applied |= LIBRARIAN_TUNE_QUEUE_CAP;        /* engaged this frame */
                    }
                }
            } else if ((cf & LIBRARIAN_TUNE_QUEUE_CAP) && g_value) {
                /* Ultra: this frame. One: the frame before it. */
                const UINT64 target = (cf & LIBRARIAN_TUNE_QUEUE_ULTRA) ? g_value : (g_value > 1 ? g_value - 1 : g_value);
                if (fence_completed() < target) {
                    gpu_wait = wait_fence(target);
                    LARGE_INTEGER t;
                    QueryPerformanceCounter(&t);
                    sweep(t.QuadPart);
                }
            }
        }
    }
    /* Feed the medians with what this frame looked like, waits included:
     * the period is the period, whoever is spending it. */
    if (frame_ms > 0.0f) window_push(&g_w_frame, frame_ms);
    window_push(&g_w_cpu, g_cpu_ms);
    g_stats->applied_flags = applied;
    g_stats->stage = LIBRARIAN_TUNE_STAGE_RECORD;

    librarian_tune_frame_t *e = &g_stats->ring[g_stats->frames % LIBRARIAN_TUNE_RING];
    e->frame_ms = frame_ms;
    e->limiter_ms = g_limiter_ms;
    e->gpu_wait_ms = gpu_wait;
    e->gpu_lat_ms = -1.0f;
    e->present_ms = present_ms;
    e->cpu_ms = g_cpu_ms;
    e->queue_depth = depth > 255 ? 255 : (uint8_t)depth;
    e->flags = (uint8_t)applied;
    e->lat_unc = 0xFFFF;
    MemoryBarrier();
    g_stats->frames++;

    /* Frames whose GPU work was found finished since the last entry. */
    for (unsigned i = 0; i < g_nparked; i++) {
        librarian_tune_frame_t *r = &g_stats->ring[g_parked[i].slot];
        r->gpu_lat_ms = g_parked[i].lat_ms;
        r->lat_unc = g_parked[i].unc;
    }
    g_nparked = 0;

    LARGE_INTEGER end;
    QueryPerformanceCounter(&end);
    g_t_after = ticks_ms(end.QuadPart - now.QuadPart);
    trace_frame(frame_ms, present_ms, gpu_wait);
    g_after_prev = end.QuadPart;
    g_stats->stage = LIBRARIAN_TUNE_STAGE_IDLE;
}

void tuning_after_present(IDXGISwapChain *chain, UINT flags, HRESULT hr)
{
    if (!g_cfg || !g_stats || g_stats->disabled) return;
    if (flags & DXGI_PRESENT_TEST) return;
    if (InterlockedCompareExchange(&g_busy, 1, 0)) return;   /* a second thread presenting: leave it alone */
    __try {
        after_present_body(chain, hr);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        give_up(LIBRARIAN_TUNE_OFF_EXCEPTION);
    }
    g_busy = 0;
}
