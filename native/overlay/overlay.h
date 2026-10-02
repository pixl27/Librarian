/*
 * Steam overlay loader — shared by the EOS and Steam proxies.
 *
 * See overlay.c for what it does and why it has to be a thread.
 */
#ifndef LIBRARIAN_OVERLAY_H
#define LIBRARIAN_OVERLAY_H

/* One preformatted line. Pass NULL to run silently. */
typedef void (*librarian_log_fn)(const char *line);

/*
 * Safe to call from DLL_PROCESS_ATTACH — it only starts a thread and returns.
 * Does nothing unless librarian_online.ini beside the calling DLL says
 * steam_overlay=1.
 */
void librarian_overlay_init(librarian_log_fn log);

#endif
