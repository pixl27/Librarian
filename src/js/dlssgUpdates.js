/* Explicit global updates; opening this panel only reads main-process state. */
(() => {
  const host = document.getElementById('fg-updates');
  if (!host) return;
  const check = document.getElementById('fg-updates-check');
  const apply = document.getElementById('fg-updates-apply');
  const message = document.getElementById('fg-updates-message');
  const release = document.getElementById('fg-updates-release');
  const progress = document.getElementById('fg-updates-progress');
  const list = document.getElementById('fg-updates-list');
  const labels = { available: 'Update available', current: 'Up to date', blocked: 'Needs attention', updating: 'Updating…', updated: 'Updated', failed: 'Update failed', skipped: 'Skipped' };
  let state = { phase: 'idle', games: [], counts: {} }, pending = false, generation = 0;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function controls() {
    const busy = pending || state.phase === 'checking' || state.phase === 'updating';
    host.setAttribute('aria-busy', String(busy));
    check.disabled = busy;
    apply.disabled = busy || state.phase !== 'ready' || !state.counts?.available;
    check.textContent = state.phase === 'checking' ? 'Checking…' : 'Check for updates';
    apply.textContent = state.phase === 'updating' ? 'Updating games…' : `Update all DLSS FG${state.counts?.available ? ` (${state.counts.available})` : ''}`;
  }
  function render(next) {
    if (!next?.phase) { message.textContent = next?.error || 'Could not read the update status. Try again.'; message.classList.add('fg-error'); return; }
    state = next; generation++;
    const counts = state.counts || {};
    message.classList.toggle('fg-error', state.phase === 'error');
    const messages = {
      idle: 'Check GitHub to see which managed games have an update available.',
      checking: 'Checking GitHub and the managed installations in your library…',
      ready: state.games.length ? `${counts.available || 0} ready to update · ${counts.current || 0} up to date · ${counts.blocked || 0} need attention.`
        : 'No Librarian-managed DLSS FG installations found. Enable DLSS FG in a game’s Graphics tab, then check again.',
      updating: `Updating DLSS FG · ${state.completed || 0} of ${state.total || 0} games completed. Keep the affected games closed.`,
      done: `${counts.updated || 0} updated · ${counts.current || 0} already current · ${(counts.skipped || 0) + (counts.blocked || 0)} skipped · ${counts.failed || 0} failed. See each game’s result below.`,
      error: state.error || 'The update check failed. Check your connection and try again.',
    };
    message.textContent = messages[state.phase] || '';
    release.classList.toggle('hidden', !state.release);
    release.textContent = state.release ? `${state.release.version ? `Native ${state.release.version} · ` : ''}GitHub revision ${state.release.commit.slice(0, 12)}${state.release.title ? ` · ${state.release.title}` : ''}` : '';
    progress.classList.toggle('hidden', state.phase !== 'updating');
    progress.max = Math.max(1, state.total || 0); progress.value = state.completed || 0;
    list.replaceChildren();
    for (const row of state.games || []) {
      const item = el('div', 'fg-update-row'); item.dataset.state = row.state;
      const identity = el('div', 'fg-update-identity');
      identity.append(el('strong', '', row.name), el('span', 'fg-path', `${row.source}${row.installedCommit ? ` · installed ${row.installedCommit.slice(0, 12)}` : ''}`));
      item.append(identity, el('span', `fg-update-state fg-update-${row.state}`, labels[row.state] || row.state));
      if (row.reason) item.append(el('p', 'fg-update-reason', row.reason));
      if (row.backup) {
        const backup = el('button', 'fg-link fg-update-backup', 'Open backup folder'); backup.type = 'button';
        backup.onclick = async () => {
          try { const error = await window.api.openPath(row.backup); if (error) throw new Error(error); }
          catch (error) { message.textContent = error.message; message.classList.add('fg-error'); }
        };
        item.append(backup);
      }
      list.append(item);
    }
    controls();
  }
  async function run(operation) {
    if (pending) return;
    pending = true; controls();
    try { render(await operation()); }
    catch (error) { message.textContent = error.message; message.classList.add('fg-error'); }
    finally { pending = false; controls(); }
  }
  check.onclick = () => run(() => window.api.checkDlssgUpdates());
  apply.onclick = () => run(() => window.api.updateAllDlssg(state.checkId));
  window.api.onDlssgUpdates(next => {
    const finished = state.phase === 'updating' && next.phase === 'done';
    render(next);
    if (finished && window.Librarian?.state.flyoutGame) window.LibrarianDlssg?.show(window.Librarian.state.flyoutGame);
  });
  const initialGeneration = generation;
  window.api.getDlssgUpdates().then(next => { if (generation === initialGeneration) render(next); }).catch(error => {
    if (generation === initialGeneration) render({ error: error.message });
  });
  window.LibrarianDlssgUpdates = { open() {
    window.Librarian?.closeFlyout();
    window.Librarian?.navigateTo('settings');
    const section = document.getElementById('settings-graphics');
    const sections = [...document.querySelectorAll('#page-settings .settings-section[data-sec]')];
    document.querySelector(`#settings-nav button[data-index="${sections.indexOf(section)}"]`)?.click();
    section.scrollIntoView({ block: 'start', behavior: 'auto' });
    check.focus({ preventScroll: true });
  } };
})();
