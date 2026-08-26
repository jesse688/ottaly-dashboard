// "What do I do now?" — one answer, shown the same way on every page.
//
// Four pages with no stated order is how the last two internal tools died:
// nice for a week, then nobody remembers which one to open on a Monday. This
// puts the same sentence and the same button at the top of all of them, so a
// CM never has to hold the sequence in their head.
//
// Usage: <script src="/next-step.js" defer></script> and, if the page has a
// client selector, call NextStep.show(workspaceId) when it changes.
(function () {
  var STEPS = ['', 'Brief', 'Market', 'Plan', 'Audience', 'Copy', 'Running'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureHost() {
    var el = document.getElementById('nextStepBar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'nextStepBar';
    var page = document.querySelector('.page');
    if (page) page.insertBefore(el, page.firstChild);
    else document.body.insertBefore(el, document.body.firstChild);
    return el;
  }

  function style() {
    if (document.getElementById('nextStepCss')) return;
    var s = document.createElement('style');
    s.id = 'nextStepCss';
    s.textContent =
      '#nextStepBar{margin:0 0 .9rem}' +
      '.ns-card{background:#fff;border:1px solid #E5E7EB;border-left:3px solid #224388;border-radius:8px;' +
        'padding:.7rem .9rem;display:flex;align-items:center;gap:.8rem;flex-wrap:wrap}' +
      '.ns-card.ns-done{border-left-color:#16a34a}' +
      '.ns-track{display:flex;gap:.3rem;align-items:center;flex-wrap:wrap}' +
      '.ns-pip{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;' +
        'padding:2px 7px;border-radius:20px;background:#F3F4F6;color:#6B7280}' +
      '.ns-pip.on{background:#224388;color:#fff}' +
      '.ns-pip.past{background:#DCFCE7;color:#166534}' +
      '.ns-body{flex:1;min-width:14rem}' +
      '.ns-what{font-size:13.5px;font-weight:700;color:#050C29}' +
      '.ns-why{font-size:11.5px;color:#6B7280;line-height:1.45;margin-top:1px}' +
      '.ns-go{padding:6px 13px;border:1.5px solid #224388;background:#224388;color:#fff;border-radius:7px;' +
        'font:600 12.5px Inter,sans-serif;cursor:pointer;text-decoration:none;white-space:nowrap}' +
      '.ns-go.ns-here{background:#fff;color:#224388}';
    document.head.appendChild(s);
  }

  function render(a) {
    style();
    var host = ensureHost();
    // On the page the action points at, the button would just reload — say so
    // rather than offering a link that appears to do nothing.
    var here = location.pathname.replace(/^\//, '') === String(a.href || '').replace(/^\//, '');
    var pips = STEPS.map(function (label, i) {
      if (!i) return '';
      var cls = i < a.step ? 'past' : i === a.step ? 'on' : '';
      return '<span class="ns-pip ' + cls + '">' + esc(label) + '</span>';
    }).join('');
    host.innerHTML =
      '<div class="ns-card' + (a.step >= 6 ? ' ns-done' : '') + '">' +
        '<div class="ns-track">' + pips + '</div>' +
        '<div class="ns-body">' +
          '<div class="ns-what">' + esc(a.what) + '</div>' +
          '<div class="ns-why">' + esc(a.why) + '</div>' +
        '</div>' +
        (here
          ? '<span class="ns-go ns-here">You are here</span>'
          : '<a class="ns-go" href="' + esc(a.href) + '">' + esc(a.cta) + '</a>') +
      '</div>';
  }

  function show(workspaceId) {
    if (!workspaceId) { var h = document.getElementById('nextStepBar'); if (h) h.innerHTML = ''; return; }
    fetch('/api/next-action?workspace_id=' + encodeURIComponent(workspaceId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) { if (a && a.what) render(a); })
      .catch(function () { /* the bar is a convenience; never break the page */ });
  }

  window.NextStep = { show: show };
})();
