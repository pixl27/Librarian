// Shared desktop focus lifecycle; nested dialogs restore their own caller.
(() => {
  const stack = [];
  const focusable = panel => [...panel.querySelectorAll('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  function enter(panel, close, titleId) {
    if (stack.some(entry => entry.panel === panel)) return;
    const entry = { panel, close, previous: document.activeElement, inert: [] };
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    if (titleId) panel.setAttribute('aria-labelledby', titleId);
    panel.tabIndex = -1;
    let branch = panel;
    while (branch.parentElement && branch !== document.body) {
      entry.inert.push([branch, branch.inert]); branch.inert = false;
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName) || sibling.id === 'toast-stack') continue;
        entry.inert.push([sibling, sibling.inert]); sibling.inert = true;
      }
      branch = branch.parentElement;
    }
    stack.push(entry);
    queueMicrotask(() => { if (stack.at(-1) === entry && !panel.contains(document.activeElement)) (focusable(panel)[0] || panel).focus({ preventScroll: true }); });
  }
  function leave(panel) {
    const index = stack.findIndex(entry => entry.panel === panel);
    if (index < 0) return;
    for (const entry of stack.splice(index).reverse()) {
      for (const [element, wasInert] of entry.inert) element.inert = wasInert;
      entry.panel.removeAttribute('aria-modal');
      if (entry.previous?.isConnected && !entry.previous.closest('[inert]')) entry.previous.focus({ preventScroll: true });
    }
  }
  document.addEventListener('keydown', event => {
    const entry = stack.at(-1);
    if (!entry) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); entry.close(); return; }
    if (event.key !== 'Tab') return;
    const elements = focusable(entry.panel);
    const index = elements.indexOf(document.activeElement);
    if (index < 0 || (!event.shiftKey && index === elements.length - 1) || (event.shiftKey && index === 0)) {
      event.preventDefault(); event.stopImmediatePropagation();
      ((event.shiftKey ? elements.at(-1) : elements[0]) || entry.panel).focus();
    }
  }, true);
  document.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.fallbackHeader !== undefined) {
      const card = img.closest('.bp-sf-card');
      const fallback = img.dataset.fallbackHeader; delete img.dataset.fallbackHeader;
      if (fallback && img.src !== fallback) {
        img.classList.add('is-wide'); card?.classList.add('is-fill');
        card?.style.setProperty('--bp-sf-fill', `url("${fallback.replace(/["\\\n\r]/g, '')}")`);
        img.dataset.hideOnError = 'card'; img.src = fallback;
      } else card?.classList.add('is-noart');
    } else if (img.dataset.hideOnError !== undefined) {
      if (img.dataset.hideOnError === 'shot') img.closest('.shot')?.style.setProperty('display', 'none');
      else if (img.dataset.hideOnError === 'card') img.closest('.bp-sf-card')?.classList.add('is-noart');
      else img.style.display = 'none';
    }
  }, true);
  window.LibrarianDialogs = {
    enter, leave,
    get activePanel() { return stack.at(-1)?.panel || null; },
    dismiss() { stack.at(-1)?.close(); },
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-tab').forEach(button => button.setAttribute('aria-label', button.querySelector('span')?.textContent.trim() || button.title));
  });
})();
