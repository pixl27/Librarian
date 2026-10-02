/*
 * The contract between Librarian and the injected overlay.
 *
 * Librarian owns the look: it renders the achievement toast as HTML, exactly
 * the same markup the windowed overlay uses, and publishes the result here as
 * raw pixels. The injected half never composes anything — it copies a bitmap
 * into the game's frame. That split is deliberate: writing a text and image
 * renderer in C++ to duplicate a design that already exists in CSS would be
 * the same work twice, and the C++ copy would be the worse of the two.
 *
 * One shared section per game process, named after its process id so two games
 * running at once never write over each other.
 *
 *   Local\LibrarianAch_<pid>
 *
 * Single writer (Librarian), single reader (the game). No locking: `seq` is
 * bumped after the pixels are written and read before they are used, so a
 * reader that catches a half-finished frame sees a stale sequence number and
 * simply draws the previous one. A torn frame is a missed frame, never a crash.
 */
#ifndef LIBRARIAN_ACH_SHARED_H
#define LIBRARIAN_ACH_SHARED_H

#include <stdint.h>

#define LIBRARIAN_ACH_MAGIC   0x4F41424CU   /* 'LBAO' */
#define LIBRARIAN_ACH_VERSION 1

/* 640x160 at 4 bytes covers the toast at the largest size it is drawn, with
 * room for the shadow. Fixed rather than negotiated: a fixed section can be
 * mapped once and never resized underneath a reader. */
#define LIBRARIAN_ACH_MAX_W 640
#define LIBRARIAN_ACH_MAX_H 160
#define LIBRARIAN_ACH_PIXEL_BYTES (LIBRARIAN_ACH_MAX_W * LIBRARIAN_ACH_MAX_H * 4)

#pragma pack(push, 4)
typedef struct {
    uint32_t magic;
    uint32_t version;

    /* Bumped by the writer after every complete frame. A reader that sees the
     * same value twice knows nothing has changed and can reuse its texture. */
    uint32_t seq;

    /* 0 hides the overlay. The writer sets it to 0 when the toast is finished
     * rather than tearing the section down, so the reader keeps its resources
     * for the next unlock instead of rebuilding them. */
    uint32_t visible;

    uint32_t width;
    uint32_t height;

    /* Where to put it, as a fraction of the frame: 0.5 / 0.04 is centred
     * horizontally, just under the top edge. Fractions rather than pixels
     * because the game's resolution is not known to the writer, and may
     * change while the game runs. */
    float anchor_x;
    float anchor_y;

    /* Scale applied to the bitmap, so a 4K frame does not get a toast the size
     * of a postage stamp. The reader multiplies by the frame height. */
    float scale;

    uint32_t reserved[6];

    uint8_t pixels[LIBRARIAN_ACH_PIXEL_BYTES];   /* BGRA, premultiplied */
} librarian_ach_shared_t;
#pragma pack(pop)

#endif /* LIBRARIAN_ACH_SHARED_H */
