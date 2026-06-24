const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z"/><path d="M9 21v-7h6v7"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8M8 12h5M8 16h8"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>',
  assets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  workspace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M12 8v8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>'
};

document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icons[node.dataset.icon] || ''; });

const statusFilter = document.querySelector('[data-status-filter]');
if (statusFilter) {
  statusFilter.addEventListener('change', () => {
    document.querySelectorAll('[data-project]').forEach((card) => {
      card.hidden = statusFilter.value !== 'all' && card.dataset.status !== statusFilter.value;
    });
  });
}

document.querySelectorAll('[data-project]').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('[data-project]').forEach((item) => item.classList.remove('selected'));
    card.classList.add('selected');
    const title = document.querySelector('[data-summary-title]');
    if (title) title.textContent = card.dataset.name;
  });
});

const dialog = document.querySelector('[data-dialog]');
document.querySelectorAll('[data-open-dialog]').forEach((button) => button.addEventListener('click', () => dialog?.classList.add('open')));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => dialog?.classList.remove('open')));
document.querySelector('[data-create-kb]')?.addEventListener('click', () => {
  const name = document.querySelector('[data-kb-name]')?.value.trim();
  if (!name) return;
  const select = document.querySelector('[data-kb-select]');
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  select?.append(option);
  if (select) select.value = name;
  dialog?.classList.remove('open');
});

document.querySelector('[data-add-rule]')?.addEventListener('click', () => {
  const notice = document.querySelector('[data-notice]');
  notice?.classList.add('show');
  setTimeout(() => notice?.classList.remove('show'), 2600);
});

document.querySelectorAll('[data-rule-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const badge = button.closest('.rule-card')?.querySelector('[data-rule-status]');
    const enabled = badge?.textContent === '已启用';
    if (badge) {
      badge.textContent = enabled ? '已禁用' : '已启用';
      badge.className = `badge ${enabled ? 'disabled' : 'enabled'}`;
    }
    button.textContent = enabled ? '启用' : '禁用';
  });
});

document.querySelectorAll('[data-delete-rule]').forEach((button) => {
  button.addEventListener('click', () => button.closest('.rule-card')?.remove());
});
