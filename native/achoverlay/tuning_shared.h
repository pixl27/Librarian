/*
 * The contract between Librarian and the in-game tuning half.
 *
 * Two fixed-size files per game process, both under
 * %LOCALAPPDATA%\Librarian\tuning\, both named after the process id so two
 * games running at once never share a byte:
 *
 *   <pid>.cfg    Librarian -> game.  Written by the launcher before the DLL is
 *                injected and rewritten whenever the user flips a switch on the
 *                Tuning page. The game maps it read-only and reads the fields on
 *                every frame, which is what makes a switch take effect live.
 *
 *   <pid>.stats  game -> Librarian.  Created and mapped read-write by the DLL,
 *                read by Librarian through the ordinary file API (one page
 *                cache, so the bytes are the same). A header plus a ring of
 *                per-frame measurements; `frames` is bumped after an entry is
 *                complete, so a reader that catches a half-written entry simply
 *                does not see it yet.
 *
 * Same discipline as the achievement overlay's section (shared.h): single
 * writer per file, no locks, torn reads are stale reads and never faults.
 */
#ifndef LIBRARIAN_TUNING_SHARED_H
#define LIBRARIAN_TUNING_SHARED_H

#include <stdint.h>

#define LIBRARIAN_TUNE_MAGIC       0x4E54424CU   /* 'LBTN' */
#define LIBRARIAN_TUNE_STATS_MAGIC 0x5354424CU   /* 'LBTS' */
#define LIBRARIAN_TUNE_VERSION     1

/* Config flags. */
enum {
    /* Hold the game to `fps_limit` frames per second, waiting just before
     * Present so the CPU never runs ahead of the display. */
    LIBRARIAN_TUNE_LIMITER     = 1u << 0,
    /* Keep at most one frame queued for the GPU: DXGI maximum frame latency 1
     * plus a wait, after Present, for the previous frame's GPU work to finish.
     * D3D11 only. */
    LIBRARIAN_TUNE_QUEUE_CAP   = 1u << 1,
    /* With QUEUE_CAP: wait for the frame just presented instead of the one
     * before it. Zero frames in flight while the CPU builds the next; lowest
     * latency, costs GPU idle time. */
    LIBRARIAN_TUNE_QUEUE_ULTRA = 1u << 2,
    /* Just in time: after Present, hold the game until its next frame's CPU
     * work would finish right as the GPU frees up, so the frame is built as
     * late as possible and Present never blocks — the input is that much
     * fresher, the GPU never idles. From the game's own measured CPU time
     * and frame period; does nothing when the CPU is the bottleneck. Takes
     * precedence over QUEUE_CAP when both are set. */
    LIBRARIAN_TUNE_QUEUE_AUTO  = 1u << 3,
};

#pragma pack(push, 4)
typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t seq;          /* bumped by the writer after every change */
    uint32_t flags;        /* LIBRARIAN_TUNE_* */
    float    fps_limit;    /* frames per second; <= 0 disables the limiter */
    uint32_t reserved[11];
} librarian_tune_config_t;  /* 64 bytes */
#pragma pack(pop)

/* Which graphics API the hooked swap chain belongs to. */
enum {
    LIBRARIAN_TUNE_API_UNKNOWN = 0,
    LIBRARIAN_TUNE_API_D3D11   = 11,
    LIBRARIAN_TUNE_API_D3D12   = 12,
};

/* What the DLL is able to do in this particular process. */
enum {
    LIBRARIAN_TUNE_CAN_LIMIT = 1u << 0,   /* always, once Present is hooked */
    LIBRARIAN_TUNE_CAN_QUEUE = 1u << 1,   /* a D3D11 device answered */
};

/* Why tuning gave up for the session (stats.disabled). */
enum {
    LIBRARIAN_TUNE_OK             = 0,
    LIBRARIAN_TUNE_OFF_EXCEPTION  = 1,   /* a fault inside a device call */
    LIBRARIAN_TUNE_OFF_ERRORS     = 2,   /* too many failed device calls */
    LIBRARIAN_TUNE_OFF_GPU_HANG   = 3,   /* repeated timeouts waiting on the GPU */
    LIBRARIAN_TUNE_OFF_OVERLAY    = 4,   /* incompatible Steam render hooks */
};

/* 8192 frames is 27 seconds at 300 fps and 2 minutes at 60: enough for any
 * A/B phase Librarian runs, without the reader having to poll faster than a
 * few times a second. */
#define LIBRARIAN_TUNE_RING 8192

#pragma pack(push, 4)
typedef struct {
    float    frame_ms;      /* interval between this Present call and the previous one */
    float    limiter_ms;    /* time spent waiting in the limiter before this Present */
    float    gpu_wait_ms;   /* time spent waiting on the GPU after this Present (queue cap) */
    /* Present call -> GPU finished this frame. Completion is only observed
     * when the render thread asks, so this is the midpoint of the interval
     * between the last "not yet" and the first "done"; lat_unc is that
     * interval's width in tenths of a millisecond (0xFFFF: still unknown).
     * < 0 while unknown. */
    float    gpu_lat_ms;
    float    present_ms;    /* time the game spent inside Present itself (blocked on the queue) */
    float    cpu_ms;        /* time the game spent between the previous Present and this one */
    uint8_t  queue_depth;   /* frames still on the GPU right after this Present, before any wait */
    uint8_t  flags;         /* config flags in effect for this frame */
    uint16_t lat_unc;
} librarian_tune_frame_t;   /* 28 bytes */

typedef struct {
    uint32_t magic;
    uint32_t version;
    uint32_t api;             /* LIBRARIAN_TUNE_API_* */
    uint32_t caps;            /* LIBRARIAN_TUNE_CAN_* */
    uint32_t frames;          /* total frames recorded; the commit marker */
    uint32_t errors;          /* non-fatal device errors so far */
    uint32_t disabled;        /* LIBRARIAN_TUNE_OFF_*; non-zero means inert for the session */
    uint32_t applied_flags;   /* what is currently in effect */
    uint32_t max_latency_prev;/* DXGI maximum frame latency before the cap changed it; 0 unknown */
    uint32_t hooks;           /* bit 0: Present, bit 1: Present1, bit 2: ExecuteCommandLists */
    /* Where the render thread last was inside this DLL (LIBRARIAN_TUNE_STAGE_*),
     * written before each step that talks to the device. A game that stops
     * presenting leaves the answer to "was it us, and where" in here. */
    uint32_t stage;
    uint32_t device_flags;    /* D3D11 creation flags of the game's device, 0 unknown */
    uint32_t reserved[4];
    librarian_tune_frame_t ring[LIBRARIAN_TUNE_RING];
} librarian_tune_stats_t;

enum {
    LIBRARIAN_TUNE_STAGE_IDLE        = 0,   /* back in the game */
    LIBRARIAN_TUNE_STAGE_BEFORE      = 1,   /* before Present: limiter, marker */
    LIBRARIAN_TUNE_STAGE_SIGNAL      = 2,   /* signalling the fence */
    LIBRARIAN_TUNE_STAGE_PRESENT     = 3,   /* inside the game's Present */
    LIBRARIAN_TUNE_STAGE_PROBE       = 4,   /* finding the device behind the chain */
    LIBRARIAN_TUNE_STAGE_FENCE       = 5,   /* creating the fence and the watcher */
    LIBRARIAN_TUNE_STAGE_CAP         = 6,   /* DXGI maximum frame latency */
    LIBRARIAN_TUNE_STAGE_SWEEP       = 7,   /* asking the fence what is done */
    LIBRARIAN_TUNE_STAGE_WAIT        = 8,   /* waiting on the fence or the clock */
    LIBRARIAN_TUNE_STAGE_RECORD      = 9,   /* writing the ring */
};
#pragma pack(pop)

#define LIBRARIAN_TUNE_STATS_HEADER 64

#endif /* LIBRARIAN_TUNING_SHARED_H */
