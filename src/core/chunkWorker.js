// Worker-thread chunk pipeline.
//
// One decrypt + decompress + SHA-1 for every chunk of every download. On a
// megabyte chunk that is a couple of milliseconds of pure CPU, and it used to
// run on the thread driving the UI: at 100 MB/s it ate a fifth of the event
// loop, and past a few hundred MB/s the event loop — not the link — was what
// limited the download. Here it runs on a real thread, one chunk at a time per
// worker, sized to the machine's cores by the pool in steamPipe.js.
//
// Buffers arrive and leave as transferred ArrayBuffers, so a chunk crosses the
// thread boundary twice without being copied either way.
const { parentPort } = require('worker_threads');
const { processChunk, shaVerify } = require('./chunkCodec');

parentPort.on('message', async (msg) => {
  const { id } = msg;
  try {
    if (msg.op === 'hash') {
      // Verify bytes read off the disk — a repair checking what is there, an
      // update recovering a chunk from the previous build. The buffer is
      // handed back with the verdict, transferred both ways, because the
      // caller usually goes on to write it somewhere.
      const data = Buffer.from(msg.data);
      const ok = shaVerify(data, Buffer.from(msg.sha));
      parentPort.postMessage({ id, ok, data: msg.data }, [msg.data]);
      return;
    }
    const out = await processChunk(Buffer.from(msg.encrypted), msg.keyHex, msg.size, Buffer.from(msg.sha));
    // Buffer.from(arrayBuffer) is a view, so `out` may sit inside a larger
    // pooled allocation. Hand back a buffer that owns its memory outright,
    // otherwise the transfer either fails or ships the whole pool.
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, result: ab }, [ab]);
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e), code: e && e.code });
  }
});
