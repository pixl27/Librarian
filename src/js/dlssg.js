/* A dedicated per-game graphics card. Async results are scoped to the open game. */
(() => {
  let generation = 0;
  const pending = new Set();
  const keyOf = game => game.install_path?.toLowerCase() || game.id || game.game_key;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  async function show(game, selection) {
    const token = ++generation, key = keyOf(game);
    const host = document.getElementById('flyout-dlssg');
    if (!host) return;
    const tab = document.getElementById('flyout-graphics-tab');
    tab.classList.add('hidden');
    host.removeAttribute('aria-busy');
    host.replaceChildren();
    host.classList.add('hidden');
    const current = () => token === generation;
    let status;
    try { status = await window.api.getDlssgStatus(game, selection); }
    catch (error) { status = { ok: false, error: error.message }; }
    if (!current()) return;
    if (status.ok && !status.visible) {
      if (document.getElementById('flyout-tab-graphics').classList.contains('active')) document.querySelector('[data-tab="overview"]').click();
      return;
    }
    tab.classList.remove('hidden');
    host.classList.remove('hidden');
    const header = el('div', 'fg-header');
    const identity = el('div', 'fg-identity');
    identity.append(el('span', 'fg-eyebrow', 'GRAPHICS · THIS GAME'));
    const title = el('h3', '', 'DLSS Frame Generation'); title.id = 'fg-title';
    identity.append(title);
    header.append(identity);
    host.append(header);
    if (!status.ok) {
      const message = el('p', 'fg-message', status.error || 'Could not check frame generation.');
      message.setAttribute('role', 'status'); host.append(message);
      const retry = el('button', 'fg-link', 'Check again'); retry.onclick = () => show(game, selection); host.append(retry);
      return;
    }
    const busy = pending.has(key);
    const toggle = el('button', 'fg-switch');
    toggle.id = 'fg-toggle'; toggle.type = 'button'; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(status.enabled)); toggle.setAttribute('aria-labelledby', 'fg-title');
    toggle.setAttribute('aria-describedby', 'fg-message'); toggle.append(el('i'));
    toggle.disabled = busy || (status.installed ? !status.canDisable : !status.canEnable);
    header.append(toggle);
    const badges = el('div', 'fg-badges');
    const state = el('span', `fg-badge ${status.enabled ? 'fg-on' : ''}`, busy ? 'Applying…' : status.enabled ? 'Enabled for next launch' : status.installed ? 'Needs attention' : 'Off');
    badges.append(state, el('span', 'fg-hardware', status.gpu.name || 'SM 8.6 GPU required'));
    host.append(badges);
    const firstIssue = (status.issues || []).find(issue => issue.severity === 'error');
    const message = el('p', 'fg-message', busy ? 'Preparing the verified package. Keep the game closed.' : firstIssue?.title || status.reason || (status.enabled
      ? 'Launch in DirectX 12 and enable Frame Generation in the game’s graphics settings.'
      : 'Enable frame generation on RTX 30 series. First use downloads the selected verified package.'));
    message.id = 'fg-message'; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); host.append(message);
    if (firstIssue) message.classList.add('fg-error');
    if (!status.installed && status.candidates.length > 1) {
      const label = el('label', 'fg-choice', 'Rendering executable');
      const select = el('select', 'xbox-input'); select.id = 'fg-executable'; select.disabled = busy;
      const placeholder = el('option', '', 'Choose the executable that renders the game'); placeholder.value = ''; select.append(placeholder);
      for (const candidate of status.candidates) { const option = el('option', '', candidate.exe); option.value = candidate.exe; select.append(option); }
      select.value = status.selected; select.onchange = () => show(game, select.value); label.append(select); host.append(label);
    }
    if (status.issues?.length) {
      const list = el('div', 'fg-issues');
      list.setAttribute('aria-label', 'Compatibility findings');
      for (const issue of status.issues) {
        const row = el('div', `fg-issue fg-issue-${issue.severity}`);
        row.dataset.code = issue.code;
        row.append(el('strong', '', issue.title), el('p', '', issue.detail)); list.append(row);
      }
      host.append(list);
    }
    const actions = el('div', 'fg-actions');
    const retry = el('button', 'fg-link', 'Check again'); retry.id = 'fg-recheck'; retry.disabled = busy; retry.onclick = () => show(game, selection);
    const folder = el('button', 'fg-link', 'Open game folder'); folder.id = 'fg-open-folder'; folder.disabled = busy || !status.target;
    folder.onclick = async () => {
      try { const error = await window.api.openPath(status.target); if (error) throw new Error(error); }
      catch (error) { message.textContent = error.message; message.classList.add('fg-error'); }
    };
    const updates = el('button', 'fg-link', 'Update DLSS FG across library'); updates.id = 'fg-open-updates'; updates.disabled = busy;
    updates.onclick = () => window.LibrarianDlssgUpdates?.open();
    actions.append(retry, folder, updates); host.append(actions);
    if (status.checks?.length) {
      const diagnostic = el('details', 'fg-details fg-diagnostics'); diagnostic.open = !!firstIssue;
      diagnostic.append(el('summary', '', 'Compatibility checks'));
      const checks = el('dl', 'fg-checks');
      for (const check of status.checks) {
        const row = el('div', 'fg-check');
        row.append(el('dt', '', check.label), el('dd', check.passed ? 'fg-check-pass' : 'fg-check-unknown', check.passed ? 'Detected' : 'Not verified'), el('dd', 'fg-check-detail', check.detail));
        checks.append(row);
      }
      diagnostic.append(checks);
      if (status.reports?.length > 1) {
        const inspected = el('div', 'fg-inspected');
        inspected.append(el('strong', '', 'Executables inspected'));
        for (const report of status.reports) inspected.append(el('p', 'fg-path', `${report.exe}: ${report.x64 ? 'x64' : report.readable ? '32-bit' : 'unreadable'} · DX12 ${report.dx12 ? 'detected' : 'not verified'} · VERSION ${report.version ? 'detected' : 'not verified'}`));
        diagnostic.append(inspected);
      }
      host.append(diagnostic);
    }
    const footer = el('div', 'fg-footer');
    footer.append(el('span', 'fg-evidence', status.reported ? 'Game reported working by upstream · experimental' : 'DLSSG files detected · compatibility unverified'));
    const details = el('details', 'fg-details');
    details.append(el('summary', '', 'Installation details'));
    const text = el('div', 'fg-detail-content');
    text.append(el('p', '', 'Use the SM 8.6 GPU and DirectX 12. The game controls the frame multiplier, up to 4×. Installing the mod does not confirm it is active in-game.'));
    if (status.target) text.append(el('p', 'fg-path', `Install beside: ${status.target}`));
    text.append(el('p', 'fg-path', `Detected: ${status.evidence.join(', ') || 'Previous installation receipt'}`));
    text.append(el('p', '', `DLSSG ${status.version ? `Native ${status.version}` : 'SM86'} · runtime ${status.runtime} · revision ${status.commit.slice(0, 7)}. Disabling removes only the two unchanged files installed by Librarian. Existing mods are preserved.`));
    const source = el('button', 'fg-link', 'Project & instructions'); source.onclick = () => window.api.openExternal(status.source);
    text.append(source); details.append(text); footer.append(details); host.append(footer);
    const apply = async () => {
      if (pending.has(key)) return;
      pending.add(key); toggle.disabled = true; host.setAttribute('aria-busy', 'true');
      state.textContent = status.installed ? 'Removing…' : 'Preparing…';
      message.textContent = status.installed ? 'Removing the files installed for this game…' : 'Downloading and verifying the package. Keep the game closed…';
      host.querySelectorAll('button, select').forEach(node => { node.disabled = true; });
      let error = '', errorCode = '';
      try {
        const result = await window.api.setDlssg({ game, enabled: !status.installed, selection: status.selected });
        if (!result.success) { error = result.error || 'Could not change frame generation.'; errorCode = result.code || ''; }
      } catch (failure) { error = failure.message; }
      finally { pending.delete(key); }
      if (!current()) {
        // Returning to this game during the download must not leave a stale busy switch.
        if (keyOf(window.Librarian?.state.flyoutGame || {}) === key) show(window.Librarian.state.flyoutGame);
        return;
      }
      host.removeAttribute('aria-busy');
      await show(game, selection);
      if (error && keyOf(window.Librarian?.state.flyoutGame || {}) === key) {
        const target = document.getElementById('fg-message');
        if (target) {
          target.textContent = error; target.classList.add('fg-error');
          const refreshedToggle = document.getElementById('fg-toggle');
          if (errorCode === 'DLSSG_DOWNLOAD_FAILED' && refreshedToggle && !refreshedToggle.disabled && refreshedToggle.getAttribute('aria-checked') === 'false') {
            const retryInstall = el('button', 'xbox-btn xbox-btn-secondary btn-sm', 'Retry installation');
            retryInstall.id = 'fg-retry-install';
            retryInstall.onclick = () => { retryInstall.disabled = true; refreshedToggle.click(); };
            document.querySelector('#flyout-dlssg .fg-actions')?.prepend(retryInstall);
          }
        }
      }
    };
    toggle.onclick = apply;
    if (status.installed && !status.enabled && status.canDisable) {
      const recover = el('button', 'xbox-btn xbox-btn-secondary btn-sm', 'Remove incomplete installation');
      recover.id = 'fg-recover'; recover.disabled = busy; recover.onclick = apply; host.append(recover);
    }
  }
  window.LibrarianDlssg = { show };
})();
