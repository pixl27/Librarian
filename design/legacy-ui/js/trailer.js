// ═══════════════════════════════════════════════════════════════════
// Librarian — trailer playback
//
// Steam stopped publishing progressive trailer files. A movie entry from
// appdetails now describes DASH and HLS manifests (dash_av1 / dash_h264 /
// hls_h264), and a bare <video> can play neither, so every trailer in the app
// went quiet. The legacy mp4 files are still served for older movies but 404
// for anything published since the change — Big Walk and PEAK have no mp4 at
// all, while ULTRAKILL still does.
//
// So: play the HLS stream through Media Source Extensions when hls.js is
// available, and fall back to the progressive files when it is not. Both the
// desktop detail view and Big Picture go through here so they cannot drift.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const HLS_OPTIONS = {
    // A trailer is decoration: never buffer more than a few seconds ahead, and
    // pick a rendition that matches the box it is playing in rather than the
    // largest one the connection could sustain.
    capLevelToPlayerSize: true,
    maxBufferLength: 12,
    maxMaxBufferLength: 24,
    enableWorker: true,
    startLevel: -1,
  };

  /** Tear down whatever was playing, including any streaming session. */
  function detach(video) {
    if (!video) return;
    try { video.pause(); } catch { /* not fatal */ }
    if (video._librarianHls) {
      try { video._librarianHls.destroy(); } catch { /* not fatal */ }
      video._librarianHls = null;
    }
    video.replaceChildren();
    video.removeAttribute('src');
    try { video.load(); } catch { /* not fatal */ }
  }

  /**
   * Point a <video> at a movie record from steamApi.getGameMedia().
   *
   * @returns true when something was actually attached. A false return means
   *   there is nothing playable for this game — callers should leave whatever
   *   still image they were showing in place rather than revealing an empty
   *   video element.
   */
  function attach(video, movie) {
    detach(video);
    if (!video || !movie) return false;

    const Hls = window.Hls;
    if (movie.hls && Hls && Hls.isSupported()) {
      const hls = new Hls(HLS_OPTIONS);
      video._librarianHls = hls;
      // A fatal stream error should leave the page exactly as if there had
      // been no trailer, not as a black rectangle.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data && data.fatal) detach(video);
      });
      hls.loadSource(movie.hls);
      hls.attachMedia(video);
      return true;
    }

    // No streaming player: fall back to the progressive files. Multiple
    // <source> children let the element itself skip the ones that 404.
    const urls = [movie.webm, movie.mp4, movie.mp4_hd].filter(Boolean);
    if (!urls.length) return false;
    for (const url of urls) {
      const source = document.createElement('source');
      source.src = url;
      video.appendChild(source);
    }
    video.load();
    return true;
  }

  window.LibrarianTrailer = { attach, detach };
})();
