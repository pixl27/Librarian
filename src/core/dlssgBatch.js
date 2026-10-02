// Main-process state survives renderer reloads. Only a checked server-side plan
// can be applied; renderer-provided paths and package URLs are never used.
const { randomUUID } = require('crypto');

function createBatch({ manager, getGames, runUpdate, getBlocker = () => '', onProgress = () => {} }) {
  let busy = false;
  let state = { ok: true, phase: 'idle', games: [], unmanaged: 0, completed: 0, total: 0 };
  const snapshot = () => JSON.parse(JSON.stringify({ ...state, counts: state.games.reduce((counts, row) => {
    counts[row.state] = (counts[row.state] || 0) + 1; return counts;
  }, {}) }));
  const emit = () => onProgress(snapshot());
  async function check() {
    if (busy) throw new Error('A DLSS FG check or update is already in progress.');
    busy = true;
    state = { ok: true, phase: 'checking', games: [], unmanaged: 0, completed: 0, total: 0 };
    emit();
    try {
      const result = await manager.checkUpdates(getGames());
      for (const row of result.games) if (row.state === 'available') {
        const reason = getBlocker(row.game);
        if (reason) { row.state = 'blocked'; row.reason = reason; }
      }
      state = { ...state, ...result, phase: 'ready', checkId: randomUUID(), checkedAt: Date.now() };
    } catch (error) { state = { ...state, ok: false, phase: 'error', error: manager.explainError(error) }; }
    finally { busy = false; emit(); }
    return snapshot();
  }
  async function update(checkId) {
    if (busy) throw new Error('A DLSS FG check or update is already in progress.');
    if (typeof checkId !== 'string' || checkId !== state.checkId || state.phase !== 'ready') throw new Error('Check for updates again before updating games.');
    const eligible = state.games.filter(row => row.state === 'available');
    if (!eligible.length) throw new Error('No managed games are ready for this update.');
    busy = true; state.phase = 'updating'; state.completed = 0; state.total = eligible.length;
    emit();
    try {
      for (const row of eligible) {
        row.state = 'updating'; emit();
        try {
          const result = await runUpdate(row.game, state.release.commit);
          if (!result?.success) throw new Error(result?.error || 'The update failed.');
          row.state = ['updated', 'current', 'skipped'].includes(result.state) ? result.state : 'updated';
          row.reason = result.reason || result.warning || '';
          if (result.backup) row.backup = result.backup;
          if (result.version) state.release.version = result.version;
          if (row.state === 'updated') row.installedCommit = state.release.commit;
        } catch (error) { row.state = 'failed'; row.reason = manager.explainError(error); }
        state.completed++; emit();
      }
      state.phase = 'done';
    } finally { busy = false; emit(); }
    return snapshot();
  }
  return { check, update, snapshot };
}

module.exports = { createBatch };
