// Ottaly sidebar navigation — narrow icon rail (65px).
// Each section: large icon + label underneath. Hover reveals flyout with links.
(function () {

  var SECTIONS = [
    {
      label: 'Infra',
      color: '#60A5FA',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
      pages: [
        { href: 'domains.html',   label: 'Domains' },
        { href: 'mailboxes.html', label: 'Mailboxes' },
        { href: 'warmup.html',    label: 'Warmup' },
        { href: 'dmarc.html',     label: 'DMARC' },
        { href: 'capacity.html',  label: 'Capacity' },
      ]
    },
    {
      label: 'Copy',
      color: '#A78BFA',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
      pages: [
        { href: 'campaigns.html',       label: 'Campaigns' },
        { href: 'autopilot.html',       label: 'Autopilot' },
        { href: 'copy.html',            label: 'Copy Analytics' },
        { href: 'leads-analysis.html',  label: 'Leads Analysis' },
      ]
    },
    {
      label: 'Data',
      color: '#22D3EE',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
      pages: [
        { href: 'contacts.html',        label: 'Contacts' },
        { href: 'engine-leads.html',    label: 'Engine Leads' },
        { href: 'companies-house.html', label: 'CH Pipeline' },
        { href: 'enrichment.html',      label: 'Enrichment' },
        { href: 'database.html',        label: 'Database' },
        { href: 'apollo-prep.html',    label: 'Apollo Prep' },
        { href: 'verify-split.html',   label: 'Verify Split' },
        { href: 'combo-analysis.html', label: 'Combo Analysis' },
        { href: 'ads.html',            label: 'Ads Checker' },
      ]
    },
    {
      label: 'Stats',
      color: '#FBBF24',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
      pages: [
        { href: 'actions.html',      label: 'Actions' },
        { href: 'stats.html',        label: 'Stats' },
        { href: 'metrics.html',      label: 'Metrics' },
        { href: 'icp.html',          label: 'Audience' },
        { href: 'diagnostics.html',   label: 'Diagnostics' },
        { href: 'intelligence.html',  label: 'Intelligence' },
        { href: 'gateway-analysis.html', label: 'Gateways' },
        { href: 'bounce-analysis.html',  label: 'Bounces' },
      ]
    },
    {
      label: 'Finance',
      color: '#4ADE80',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
      admin: true,
      pages: [
        { href: 'finance.html', label: 'Finance' },
        { href: 'index.html',   label: 'Revenue' },
      ]
    },
    {
      label: 'Clients',
      color: '#FB923C',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
      pages: [
        { href: 'clients.html', label: 'Clients', manager: true },
      ]
    },
    {
      label: 'Admin',
      color: '#F87171',
      icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M4.93 19.07l1.41-1.41M19.07 19.07l-1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>',
      pages: [
        { href: 'admin.html',      label: 'Admin Settings', admin: true },
        { href: 'workload.html',   label: 'CM Workload',    manager: true },
        { href: 'commission.html', label: 'Commission',     manager: true },
      ]
    },
  ];

  window.OTTALY_PAGES = [];
  SECTIONS.forEach(function (s) { window.OTTALY_PAGES = window.OTTALY_PAGES.concat(s.pages); });

  var SIDEBAR_W = 65;
  var FLYOUT_W  = 170;
  var current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

  function burgerIcon() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  }
  function xIcon() {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }

  function visiblePages(pages, role) {
    return pages.filter(function (p) {
      if (p.admin && role !== 'admin') return false;
      if (p.manager && role !== 'manager' && role !== 'admin') return false;
      return true;
    });
  }

  function sectionVisible(section, role) {
    if (section.admin && role !== 'admin') return false;
    return visiblePages(section.pages, role).length > 0;
  }

  function pageIsActive(href) { return href.toLowerCase() === current; }
  function sectionHasActive(section) {
    return section.pages.some(function (p) { return pageIsActive(p.href); });
  }

  // ── Inject CSS ──
  function injectCSS() {
    if (document.getElementById('_ottaly_sidebar_css')) return;
    var s = document.createElement('style');
    s.id = '_ottaly_sidebar_css';
    s.textContent =
      'body { margin-left: ' + SIDEBAR_W + 'px !important; }\n' +

      '#ottaly-sidebar {' +
      '  position: fixed; top: 0; left: 0; bottom: 0;' +
      '  width: ' + SIDEBAR_W + 'px;' +
      '  background: #050C29;' +
      '  display: flex; flex-direction: column;' +
      '  z-index: 10000;' +
      '  border-right: 1px solid rgba(255,255,255,0.07);' +
      '  overflow: visible;' +
      '}\n' +
      '#ottaly-sidebar::before {' +
      '  content: "";' +
      '  position: absolute;' +
      '  inset: 0;' +
      '  background: url("/favicon.svg") center/160% no-repeat;' +
      '  filter: invert(1);' +
      '  opacity: 0.04;' +
      '  pointer-events: none;' +
      '  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%);' +
      '  mask-image: linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%);' +
      '}\n' +

      // Logo
      '.o-sb-logo {' +
      '  padding: 12px 0 10px;' +
      '  border-bottom: 1px solid rgba(255,255,255,0.07);' +
      '  flex-shrink: 0;' +
      '  display: flex; align-items: center; justify-content: center;' +
      '}\n' +
      '.o-sb-logo a { display: flex; align-items: center; justify-content: center; text-decoration: none; }\n' +
      '.o-sb-logo img { height: 28px; width: auto; display: block; }\n' +

      // Sections list
      '.o-sb-sections { flex: 1; padding: 6px 0; overflow-y: auto; overflow-x: visible; scrollbar-width: none; }\n' +
      '.o-sb-sections::-webkit-scrollbar { display: none; }\n' +

      // Each section wrapper — position:relative for flyout
      '.o-sb-wrap {' +
      '  position: relative;' +
      '}\n' +

      // Icon button
      '.o-sb-btn {' +
      '  width: 100%;' +
      '  display: flex; flex-direction: column; align-items: center; justify-content: center;' +
      '  gap: 4px;' +
      '  padding: 10px 4px;' +
      '  background: none; border: none; cursor: pointer;' +
      '  --section-color: rgba(255,255,255,0.5);' +
      '  transition: background .15s;' +
      '  border-left: 3px solid transparent;' +
      '}\n' +
      '.o-sb-btn-icon {' +
      '  display: flex; align-items: center; justify-content: center;' +
      '  color: color-mix(in srgb, var(--section-color) 55%, transparent);' +
      '  transition: color .15s;' +
      '}\n' +
      '.o-sb-btn-label { transition: color .15s; color: color-mix(in srgb, var(--section-color) 40%, transparent); }\n' +
      '.o-sb-btn:hover { background: color-mix(in srgb, var(--section-color) 10%, transparent); }\n' +
      '.o-sb-btn:hover .o-sb-btn-icon { color: var(--section-color); }\n' +
      '.o-sb-btn:hover .o-sb-btn-label { color: color-mix(in srgb, var(--section-color) 80%, white); }\n' +
      '.o-sb-btn.active { border-left-color: var(--section-color); background: color-mix(in srgb, var(--section-color) 15%, transparent); }\n' +
      '.o-sb-btn.active .o-sb-btn-icon { color: #fff; }\n' +
      '.o-sb-btn.active .o-sb-btn-label { color: var(--section-color); font-weight: 800; }\n' +
      '.o-sb-btn-label {' +
      '  font: 700 9px/1 "Inter",sans-serif;' +
      '  text-transform: uppercase;' +
      '  letter-spacing: 0.5px;' +
      '  white-space: nowrap;' +
      '}\n' +

      // Flyout panel
      '.o-sb-flyout {' +
      '  display: none;' +
      '  position: fixed;' +
      '  left: ' + SIDEBAR_W + 'px;' +
      '  min-width: ' + FLYOUT_W + 'px;' +
      '  background: #0d1b3e;' +
      '  border: 1px solid rgba(255,255,255,0.1);' +
      '  border-left: 3px solid #1F6F78;' +
      '  border-radius: 0 8px 8px 0;' +
      '  padding: 6px 0;' +
      '  z-index: 10001;' +
      '  box-shadow: 4px 4px 20px rgba(0,0,0,0.4);' +
      '}\n' +
      '.o-sb-wrap:hover .o-sb-flyout { display: block; }\n' +
      '.o-sb-flyout-title {' +
      '  padding: 6px 14px 8px;' +
      '  font: 700 10px/1 "Inter",sans-serif;' +
      '  text-transform: uppercase;' +
      '  letter-spacing: 0.6px;' +
      '  color: rgba(255,255,255,0.35);' +
      '  border-bottom: 1px solid rgba(255,255,255,0.07);' +
      '  margin-bottom: 4px;' +
      '}\n' +
      '.o-sb-flyout a {' +
      '  display: block;' +
      '  padding: 8px 16px;' +
      '  font: 500 13px/1 "Inter",sans-serif;' +
      '  color: rgba(255,255,255,0.6);' +
      '  text-decoration: none;' +
      '  transition: color .1s, background .1s;' +
      '  white-space: nowrap;' +
      '}\n' +
      '.o-sb-flyout a:hover { color: #fff; background: rgba(255,255,255,0.07); }\n' +
      '.o-sb-flyout a.active { color: #fff; background: rgba(31,111,120,0.25); padding-left: 13px; border-left: 3px solid #1F6F78; }\n' +

      // Mobile overlay
      '#ottaly-sb-overlay { display: none; position: fixed; inset: 0; z-index: 9990; background: rgba(0,0,0,0.4); }\n' +
      '#ottaly-sb-overlay.open { display: block; }\n' +

      // Mobile hamburger
      '#ottaly-hamburger {' +
      '  position: fixed; top: 10px; left: 10px;' +
      '  z-index: 10001; display: none;' +
      '  background: #050C29; border: none; cursor: pointer;' +
      '  padding: 8px; border-radius: 7px;' +
      '  color: rgba(255,255,255,0.8);' +
      '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);' +
      '}\n' +

      '@media (max-width: 900px) {\n' +
      '  body { margin-left: 0 !important; }\n' +
      '  #ottaly-sidebar { transform: translateX(-100%); transition: transform .22s ease; }\n' +
      '  #ottaly-sidebar.open { transform: translateX(0); }\n' +
      '  #ottaly-hamburger { display: flex; align-items: center; justify-content: center; }\n' +
      '}\n' +

      '#ottaly-nav, #ottaly-logo { display: none !important; }\n' +

      // ── Chat panel ──
      '#ottaly-chat-panel{position:fixed;top:0;right:-440px;bottom:0;width:420px;background:#0d1b3e;border-left:1px solid rgba(255,255,255,0.1);z-index:19999;display:flex;flex-direction:column;transition:right .25s ease;box-shadow:-4px 0 24px rgba(0,0,0,0.5);}\n' +
      '#ottaly-chat-panel.open{right:0;}\n' +
      '#ottaly-chat-panel.minimised{top:auto;height:auto;right:0;}\n' +
      '#ottaly-chat-panel.minimised #ottaly-chat-messages,#ottaly-chat-panel.minimised #ottaly-chat-foot{display:none;}\n' +
      '#ottaly-chat-hd{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}\n' +
      '#ottaly-chat-hd h3{margin:0;font:600 14px Inter,sans-serif;color:#fff;display:flex;align-items:center;gap:8px;}\n' +
      '#ottaly-chat-close{background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);font-size:18px;line-height:1;padding:2px 4px;transition:color .15s;}\n' +
      '#ottaly-chat-close:hover{color:#fff;}\n' +
      '#ottaly-chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent;}\n' +
      '.o-msg{max-width:90%;padding:10px 13px;border-radius:12px;font:400 13px/1.55 Inter,sans-serif;white-space:pre-wrap;word-break:break-word;}\n' +
      '.o-msg.user{background:#1F6F78;color:#fff;align-self:flex-end;border-bottom-right-radius:3px;}\n' +
      '.o-msg.assistant{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.88);align-self:flex-start;border-bottom-left-radius:3px;}\n' +
      '.o-msg.err{background:rgba(239,68,68,0.15);color:#FCA5A5;align-self:flex-start;}\n' +
      '#ottaly-chat-foot{padding:12px 14px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:8px;flex-shrink:0;}\n' +
      '#ottaly-chat-input{flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:9px 12px;color:#fff;font:400 13px Inter,sans-serif;outline:none;resize:none;max-height:100px;overflow-y:auto;}\n' +
      '#ottaly-chat-input::placeholder{color:rgba(255,255,255,0.28);}\n' +
      '#ottaly-chat-input:focus{border-color:#1F6F78;}\n' +
      '#ottaly-chat-send{background:#1F6F78;border:none;border-radius:8px;padding:9px 14px;cursor:pointer;color:#fff;font:600 13px Inter,sans-serif;transition:background .15s;flex-shrink:0;}\n' +
      '#ottaly-chat-send:hover{background:#17585e;}\n' +
      '#ottaly-chat-send:disabled{opacity:0.45;cursor:not-allowed;}\n' +
      '.o-chat-toggle{width:100%;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 4px;background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.35);transition:color .15s,background .15s;border-left:3px solid transparent;}\n' +
      '.o-chat-toggle:hover{color:rgba(255,255,255,0.8);background:rgba(255,255,255,0.06);}\n' +
      '.o-chat-toggle span{font:700 8px/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:0.5px;}\n' +
      '.o-chat-icon-btn{background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);font-size:16px;line-height:1;padding:3px 6px;border-radius:5px;transition:color .15s,background .15s;}\n' +
      '.o-chat-icon-btn:hover{color:#fff;background:rgba(255,255,255,0.08);}\n' +
      '#ottaly-chat-hd{padding:13px 14px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}\n' +
      '#ottaly-chat-hd h3{margin:0;font:600 13px Inter,sans-serif;color:#fff;display:flex;align-items:center;gap:7px;}\n' +
      '#o-chat-input{flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:9px 12px;color:#fff;font:400 13px Inter,sans-serif;outline:none;resize:none;max-height:100px;overflow-y:auto;}\n' +
      '#o-chat-input::placeholder{color:rgba(255,255,255,0.28);}\n' +
      '#o-chat-input:focus{border-color:#1F6F78;}\n' +
      '#o-chat-send{background:#1F6F78;border:none;border-radius:8px;padding:9px 16px;cursor:pointer;color:#fff;font:600 13px Inter,sans-serif;transition:background .15s;flex-shrink:0;}\n' +
      '#o-chat-send:hover{background:#17585e;}\n' +
      '#o-chat-send:disabled{opacity:0.45;cursor:not-allowed;}\n' +
      '.o-chat-list-item{display:flex;align-items:center;gap:12px;padding:11px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);}\n';

    document.head.appendChild(s);
  }

  // ── Build sidebar ──
  function buildSidebar(role) {
    var el = document.createElement('aside');
    el.id = 'ottaly-sidebar';

    // Logo
    var logo = document.createElement('div');
    logo.className = 'o-sb-logo';
    logo.innerHTML = '<a href="/index.html"><img src="/favicon.svg" alt="Ottaly" style="filter:brightness(10)"></a>';
    el.appendChild(logo);

    var sections = document.createElement('div');
    sections.className = 'o-sb-sections';

    SECTIONS.forEach(function (section) {
      if (!sectionVisible(section, role)) return;
      var pages = visiblePages(section.pages, role);
      if (!pages.length) return;

      var hasActive = sectionHasActive(section);

      var wrap = document.createElement('div');
      wrap.className = 'o-sb-wrap';

      // Icon button
      var btn = document.createElement('button');
      btn.className = 'o-sb-btn' + (hasActive ? ' active' : '');
      if (section.color) btn.style.setProperty('--section-color', section.color);
      btn.innerHTML =
        '<span class="o-sb-btn-icon">' + section.icon + '</span>' +
        '<span class="o-sb-btn-label">' + section.label + '</span>';

      // Flyout
      var flyout = document.createElement('div');
      flyout.className = 'o-sb-flyout';
      if (section.color) flyout.style.borderLeftColor = section.color;

      var title = document.createElement('div');
      title.className = 'o-sb-flyout-title';
      title.textContent = section.label;
      flyout.appendChild(title);

      pages.forEach(function (p) {
        var a = document.createElement('a');
        a.href = p.href;
        a.textContent = p.label;
        if (pageIsActive(p.href)) a.className = 'active';
        flyout.appendChild(a);
      });

      // Position flyout vertically aligned to the button on hover
      wrap.addEventListener('mouseenter', function () {
        var rect = wrap.getBoundingClientRect();
        flyout.style.top = rect.top + 'px';
      });

      wrap.appendChild(btn);
      wrap.appendChild(flyout);
      sections.appendChild(wrap);
    });

    el.appendChild(sections);

    // My Clients toggle — only for managers
    if (role === 'manager') {
      var myClientsDiv = document.createElement('div');
      myClientsDiv.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);padding:8px 0;flex-shrink:0;';
      var myClientsBtn = document.createElement('button');
      myClientsBtn.id = 'ottaly-myclients-btn';
      myClientsBtn.title = 'Filter to my clients only';
      myClientsBtn.style.cssText = 'width:100%;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px;background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.3);transition:color .15s,background .15s;';
      myClientsBtn.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>' +
        '<span style="font:700 8px/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Mine</span>';
      // Restore state
      var cmFilter = _getCMFilter();
      if (cmFilter && cmFilter.enabled) {
        myClientsBtn.style.color = '#1F6F78';
        myClientsBtn.style.background = 'rgba(31,111,120,0.15)';
        myClientsBtn.title = 'Showing my clients only — click to show all';
      }
      myClientsBtn.addEventListener('click', function() { _toggleCMFilter(myClientsBtn); });
      myClientsDiv.appendChild(myClientsBtn);
      el.appendChild(myClientsDiv);
    }

    // Sign-out pinned at bottom
    var signoutDiv = document.createElement('div');
    signoutDiv.style.cssText = 'border-top:1px solid rgba(255,255,255,0.07);padding:10px 0;flex-shrink:0;';
    var signoutBtn = document.createElement('a');
    signoutBtn.href = '/login.html';
    signoutBtn.id = 'ottaly-signout-btn';
    signoutBtn.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;color:rgba(255,255,255,0.3);text-decoration:none;transition:color .15s;';
    signoutBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
      '<span style="font:700 8px/1 Inter,sans-serif;text-transform:uppercase;letter-spacing:0.5px;">Out</span>';
    signoutBtn.addEventListener('click', function (e) {
      e.preventDefault();
      fetch('/api/logout', { method: 'POST' }).finally(function() {
        window.location.href = '/login.html';
      });
    });
    signoutBtn.addEventListener('mouseover', function () { signoutBtn.style.color = 'rgba(255,255,255,0.75)'; });
    signoutBtn.addEventListener('mouseout',  function () { signoutBtn.style.color = 'rgba(255,255,255,0.3)'; });
    signoutDiv.appendChild(signoutBtn);
    el.appendChild(signoutDiv);

    return el;
  }

  // ── Mobile toggle ──
  var _open = false;
  function setupMobile() {
    var overlay = document.createElement('div');
    overlay.id = 'ottaly-sb-overlay';
    document.body.appendChild(overlay);

    var btn = document.createElement('button');
    btn.id = 'ottaly-hamburger';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = burgerIcon();
    document.body.appendChild(btn);

    function open() {
      _open = true;
      var sb = document.getElementById('ottaly-sidebar');
      if (sb) sb.classList.add('open');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      btn.innerHTML = xIcon();
    }
    function close() {
      _open = false;
      var sb = document.getElementById('ottaly-sidebar');
      if (sb) sb.classList.remove('open');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
      btn.innerHTML = burgerIcon();
    }

    btn.addEventListener('click', function () { _open ? close() : open(); });
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && _open) close(); });
  }

  // ── AI Chat ──
  function setupChat() {
    if (document.getElementById('ottaly-chat-panel')) return;

    var STORE = 'ottaly_chats_v2';
    var state = { open: false, minimised: false, view: 'list', activeId: null, chats: [] };

    function loadState() { try { var d = JSON.parse(localStorage.getItem(STORE)||'{}'); state.chats=d.chats||[]; state.activeId=d.activeId||null; } catch {} }
    function saveState() { try { localStorage.setItem(STORE, JSON.stringify({chats:state.chats,activeId:state.activeId})); } catch {} }
    function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
    function active() { return state.chats.find(function(c){return c.id===state.activeId;}); }
    loadState();

    // ── Panel ──
    var panel = document.createElement('div');
    panel.id = 'ottaly-chat-panel';
    panel.innerHTML =
      '<div id="o-chat-hd"></div>' +
      '<div id="o-chat-body" style="flex:1;overflow:hidden;display:flex;flex-direction:column;"></div>' +
      '<div id="o-chat-foot" style="display:none;padding:12px 14px;border-top:1px solid rgba(255,255,255,0.08);gap:8px;flex-shrink:0;">' +
        '<textarea id="o-chat-input" rows="1" placeholder="Ask anything about your data…"></textarea>' +
        '<button id="o-chat-send">Send</button>' +
      '</div>';
    document.body.appendChild(panel);

    var hd    = document.getElementById('o-chat-hd');
    var body  = document.getElementById('o-chat-body');
    var foot  = document.getElementById('o-chat-foot');
    var input = document.getElementById('o-chat-input');
    var send  = document.getElementById('o-chat-send');

    // ── Helpers ──
    function iconBtn(id, title, label) {
      return '<button class="o-chat-icon-btn" id="'+id+'" title="'+title+'">'+label+'</button>';
    }
    function appendMsg(role, text, container) {
      var el = container || document.getElementById('o-chat-msgs');
      if (!el) return null;
      var div = document.createElement('div');
      div.className = 'o-msg ' + role;
      div.textContent = text;
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
      return div;
    }
    function wireHd() {
      var b;
      b = document.getElementById('o-chat-back');  if(b) b.addEventListener('click', function(){renderList();});
      b = document.getElementById('o-chat-new');   if(b) b.addEventListener('click', newChat);
      b = document.getElementById('o-chat-min');   if(b) b.addEventListener('click', toggleMin);
      b = document.getElementById('o-chat-close'); if(b) b.addEventListener('click', closePanel);
    }

    // ── Render: list ──
    function renderList() {
      state.view = 'list';
      foot.style.display = 'none';
      hd.innerHTML =
        '<h3><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1F6F78" stroke-width="2.2" stroke-linecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>&nbsp;Ottaly AI</h3>' +
        '<div style="display:flex;gap:5px;">'+iconBtn('o-chat-new','New chat','＋')+iconBtn('o-chat-min','Minimise','−')+iconBtn('o-chat-close','Close','✕')+'</div>';
      wireHd();
      if (!state.chats.length) {
        body.innerHTML = '<div style="padding:40px 20px;text-align:center;color:rgba(255,255,255,0.32);font:400 13px Inter,sans-serif;">No conversations yet.<br><br><button onclick="window._ottalyNewChat()" style="background:#1F6F78;border:none;border-radius:8px;padding:9px 20px;color:#fff;font:600 13px Inter,sans-serif;cursor:pointer;">Start a chat</button></div>';
        return;
      }
      var list = document.createElement('div');
      list.style.cssText = 'overflow-y:auto;flex:1;';
      state.chats.forEach(function(c) {
        var lastUser = c.messages.filter(function(m){return m.role==='user';}).slice(-1)[0];
        var preview  = lastUser ? lastUser.content.slice(0,65) : 'Empty';
        var dt = new Date(c.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
        var row = document.createElement('div');
        row.className = 'o-chat-list-item'; row.dataset.id = c.id;
        row.innerHTML =
          '<div style="flex:1;min-width:0;">' +
            '<div style="font:500 13px Inter,sans-serif;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+(c.title||'Conversation')+'</div>'+
            '<div style="font:400 11px Inter,sans-serif;color:rgba(255,255,255,0.32);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">'+preview+'</div>'+
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
            '<span style="font:400 11px Inter,sans-serif;color:rgba(255,255,255,0.22);">'+dt+'</span>'+
            '<button class="o-del-chat" data-id="'+c.id+'" style="background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.18);font-size:14px;padding:2px 5px;line-height:1;transition:color .15s;" title="Delete">✕</button>'+
          '</div>';
        row.addEventListener('click', function(e) {
          if (e.target.classList.contains('o-del-chat')) return;
          state.activeId = c.id; saveState(); renderChat();
        });
        row.addEventListener('mouseenter', function(){ row.style.background='rgba(255,255,255,0.05)'; });
        row.addEventListener('mouseleave', function(){ row.style.background=''; });
        var del = row.querySelector('.o-del-chat');
        del.addEventListener('click', function(e){ e.stopPropagation(); state.chats=state.chats.filter(function(x){return x.id!==c.id;}); if(state.activeId===c.id)state.activeId=null; saveState(); renderList(); });
        del.addEventListener('mouseenter', function(){ del.style.color='#FCA5A5'; });
        del.addEventListener('mouseleave', function(){ del.style.color='rgba(255,255,255,0.18)'; });
        list.appendChild(row);
      });
      body.innerHTML = '';
      body.appendChild(list);
    }

    // ── Render: chat ──
    function renderChat(focusInput) {
      state.view = 'chat';
      var chat = active();
      if (!chat) { renderList(); return; }
      hd.innerHTML =
        '<div style="display:flex;align-items:center;gap:7px;min-width:0;flex:1;">'+
          iconBtn('o-chat-back','All chats','←')+
          '<h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;flex:1;" id="o-chat-title">'+chat.title+'</h3>'+
        '</div>'+
        '<div style="display:flex;gap:5px;">'+iconBtn('o-chat-min','Minimise','−')+iconBtn('o-chat-close','Close','✕')+'</div>';
      wireHd();
      foot.style.display = 'flex';
      var msgs = document.createElement('div');
      msgs.id = 'o-chat-msgs';
      msgs.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.1) transparent;';
      if (!chat.messages.length) {
        var hint = document.createElement('div');
        hint.style.cssText = 'padding:24px 0;text-align:center;color:rgba(255,255,255,0.28);font:400 13px Inter,sans-serif;';
        hint.textContent = 'Ask me anything about your campaigns, revenue, or copy performance.';
        msgs.appendChild(hint);
      } else {
        chat.messages.forEach(function(m){ appendMsg(m.role, m.content, msgs); });
        setTimeout(function(){ msgs.scrollTop = msgs.scrollHeight; }, 0);
      }
      body.innerHTML = '';
      body.appendChild(msgs);
      if (focusInput !== false) setTimeout(function(){ try{input.focus();}catch(_){}}, 50);
    }

    // ── Actions ──
    function newChat() {
      var id = uid();
      state.chats.unshift({ id:id, title:'New conversation', messages:[], createdAt:new Date().toISOString() });
      state.activeId = id; saveState(); renderChat();
    }
    window._ottalyNewChat = newChat;

    function openPanel() {
      state.open = true; state.minimised = false;
      panel.classList.add('open'); panel.classList.remove('minimised');
      if (!state.chats.length) { newChat(); }
      else if (state.activeId && active()) { renderChat(false); }
      else { renderList(); }
    }
    function closePanel() { state.open = false; panel.classList.remove('open','minimised'); }
    function toggleMin() {
      state.minimised = !state.minimised;
      panel.classList.toggle('minimised', state.minimised);
      var b = document.getElementById('o-chat-min');
      if (b) b.textContent = state.minimised ? '□' : '−';
    }

    // ── Send ──
    input.addEventListener('input', function(){ this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,100)+'px'; });
    input.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();} });
    send.addEventListener('click', doSend);

    function doSend() {
      var text = input.value.trim();
      if (!text || send.disabled) return;
      var chat = active(); if (!chat) return;
      input.value = ''; input.style.height = 'auto'; send.disabled = true;
      chat.messages.push({ role:'user', content:text });
      if (chat.title === 'New conversation') chat.title = text.slice(0,50)+(text.length>50?'…':'');
      saveState();
      var hint = document.querySelector('#o-chat-msgs div[style*="text-align:center"]');
      if (hint) hint.remove();
      appendMsg('user', text);
      var thinking = appendMsg('assistant', '…');
      var hdTitle = document.getElementById('o-chat-title');
      if (hdTitle) hdTitle.textContent = chat.title;
      var sel = document.querySelector('#wsSelect,select[id$="Select"]');
      var wsId = sel ? (sel.value||null) : null;
      var history = chat.messages.slice(0,-1).slice(-18).map(function(m){return{role:m.role,content:m.content};});
      fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,history:history,workspace_id:wsId})})
        .then(function(r){return r.json();})
        .then(function(d){
          var reply = d.error ? ('Error: '+d.error) : (d.reply||'No response');
          if(thinking){thinking.textContent=reply;thinking.className=d.error?'o-msg err':'o-msg assistant';}
          if(!d.error){chat.messages.push({role:'assistant',content:reply});saveState();}
          var msgs=document.getElementById('o-chat-msgs');if(msgs)msgs.scrollTop=msgs.scrollHeight;
        })
        .catch(function(){if(thinking){thinking.className='o-msg err';thinking.textContent='Network error — try again.';}})
        .finally(function(){send.disabled=false;setTimeout(function(){try{input.focus();}catch(_){}},50);});
    }

    // Toggle via sidebar button (event delegation — survives sidebar rebuild)
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.o-chat-toggle')) return;
      if (state.open && !state.minimised) closePanel(); else openPanel();
    });
  }

  // ── Init ──
  function init() {
    injectCSS();

    // Render hidden until session resolves — prevents admin sections flashing for managers
    var sidebar = buildSidebar('admin');
    sidebar.style.visibility = 'hidden';
    document.body.insertBefore(sidebar, document.body.firstChild);
    setupMobile();
    setupChat();

    fetch('/api/session')
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: true, role: 'admin', name: '' }; })
      .then(function (s) {
        if (s && s.ok === false) return;
        var role = (s && s.role) || 'admin';
        window._ottalyRole = role;
        window._ottalyName = (s && s.name) || '';

        var old = document.getElementById('ottaly-sidebar');
        var newSb = buildSidebar(role);
        if (old) old.replaceWith(newSb);

        try { document.dispatchEvent(new CustomEvent('ottaly:session', { detail: s })); } catch (_) {}
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ── CM "My Clients" filter ────────────────────────────────────────────
  var CM_FILTER_KEY = 'ottaly_cm_filter';

  function _getCMFilter() {
    try { return JSON.parse(localStorage.getItem(CM_FILTER_KEY) || 'null'); } catch { return null; }
  }

  function _setCMFilter(filter) {
    if (filter) localStorage.setItem(CM_FILTER_KEY, JSON.stringify(filter));
    else localStorage.removeItem(CM_FILTER_KEY);
  }

  // Apply filter to a single <select> element
  function _applyFilterToSelect(sel) {
    var filter = _getCMFilter();
    if (!filter || !filter.enabled || !filter.workspaceIds) return;
    var ids = filter.workspaceIds;
    Array.from(sel.options).forEach(function(opt) {
      if (opt.value && !ids.includes(opt.value)) {
        opt.style.display = 'none'; opt.disabled = true;
      }
    });
    // If current value is not in allowed set, switch to first valid option
    if (sel.value && !ids.includes(sel.value)) {
      var first = Array.from(sel.options).find(function(o) { return !o.disabled && o.value; });
      if (first) { sel.value = first.value; sel.dispatchEvent(new Event('change')); }
    }
  }

  // Watch for workspace selects being populated and auto-filter them
  var _wsObserver = new MutationObserver(function() {
    var filter = _getCMFilter();
    if (!filter || !filter.enabled) return;
    var selectors = ['#wsSelect','#pvWorkspace','#wsFilter','#enrichWorkspace','select[id$="WsSelect"]'];
    selectors.forEach(function(s) {
      var el = document.querySelector(s);
      if (el && el.options.length > 1 && !el.dataset.cmFiltered) {
        el.dataset.cmFiltered = '1';
        _applyFilterToSelect(el);
      }
    });
  });
  _wsObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Expose globally so pages can call manually if needed
  window.getCMFilter    = _getCMFilter;
  window.applyCMFilter  = _applyFilterToSelect;

  async function _toggleCMFilter(btn) {
    var current = _getCMFilter();
    if (current && current.enabled) {
      // Turn off
      _setCMFilter(null);
      btn.style.color = 'rgba(255,255,255,0.3)';
      btn.style.background = 'none';
      btn.title = 'Filter to my clients only';
      // Re-enable all options in workspace selects
      document.querySelectorAll('select[data-cm-filtered]').forEach(function(sel) {
        delete sel.dataset.cmFiltered;
        Array.from(sel.options).forEach(function(o) { o.disabled = false; o.style.display = ''; });
        sel.dispatchEvent(new Event('change'));
      });
      window.dispatchEvent(new CustomEvent('ottaly:cm-filter-changed', { detail: { enabled: false } }));
    } else {
      // Turn on — fetch assigned clients
      try {
        var r = await fetch('/api/my-clients');
        var d = await r.json();
        if (!d.clients || !d.clients.length) {
          alert('No clients are assigned to you yet. Ask an admin to assign clients on the CM Workload page.');
          return;
        }
        var ids = d.clients.map(function(c) { return c.workspace_id; });
        _setCMFilter({ enabled: true, workspaceIds: ids, manager: d.manager });
        btn.style.color = '#1F6F78';
        btn.style.background = 'rgba(31,111,120,0.15)';
        btn.title = 'Showing my clients only — click to show all';
        // Apply to any already-loaded workspace selects
        document.querySelectorAll('select').forEach(function(sel) {
          if (sel.id && (sel.id.includes('ws') || sel.id.includes('Ws') || sel.id === 'pvWorkspace')) {
            delete sel.dataset.cmFiltered;
            Array.from(sel.options).forEach(function(o) { o.disabled = false; o.style.display = ''; });
            _applyFilterToSelect(sel);
          }
        });
        window.dispatchEvent(new CustomEvent('ottaly:cm-filter-changed', { detail: { enabled: true, workspaceIds: ids } }));
      } catch (e) {
        alert('Could not load your clients: ' + e.message);
      }
    }
  }

})();
