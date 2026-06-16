(function () {
  'use strict';

  // Get token from injected global (set by backend when serving HTML)
  let token = window.AUTH_TOKEN || sessionStorage.getItem('auth-token');

  if (!token) {
    alert('No token provided');
    return;
  }
  sessionStorage.setItem('auth-token', token);

  const baseUrl = window.location.origin;

  async function apiCall(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(baseUrl + path, opts);
    if (res.status === 401) {
      sessionStorage.removeItem('auth-token');
      location.reload();
      return null;
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  // Load and render subscriptions list grouped by month
  async function loadList() {
    const subs = await apiCall('GET', '/api/subscriptions');
    const listDiv = document.getElementById('subsList');
    listDiv.innerHTML = '';
    if (!subs || subs.length === 0) {
      listDiv.innerHTML = '<div class="empty">No subscriptions found</div>';
      return;
    }

    // Group by month (started_at or created_at, back to Jan 2026)
    const months = {};
    for (const sub of subs) {
      const dateStr = sub.started_at || sub.created_at;
      const date = new Date(dateStr);
      const monthKey = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
      if (!months[monthKey]) months[monthKey] = [];
      months[monthKey].push(sub);
    }

    // Sort months chronologically
    const sortedMonths = Object.keys(months).sort((a, b) => new Date(a) - new Date(b));

    for (const monthKey of sortedMonths) {
      const monthSubs = months[monthKey];
      const section = document.createElement('div');
      section.className = 'month-section';
      const monthTotal = monthSubs.reduce((sum, s) => sum + (s.monthly_equiv || 0), 0);
      const monthCurrency = monthSubs[0].currency || 'USD';

      section.innerHTML = `
        <div class="month-header" style="cursor: pointer;">
          <h3 style="margin: 0;">${monthKey} <span class="count">(${monthSubs.length})</span></h3>
          <div style="text-align: right;">
            <div style="font-weight: 600;">${monthTotal.toFixed(2)} ${monthCurrency}/mo</div>
            <div style="font-size: 12px; color: #999;">↓ collapse</div>
          </div>
        </div>
        <div class="month-content"></div>
      `;

      const contentDiv = section.querySelector('.month-content');
      for (const sub of monthSubs) {
        const card = document.createElement('div');
        card.className = 'sub-card';
        const trialWarning = sub.status === 'trial' && sub.trial_ends_at
          ? `<div class="sub-trial-warning">Trial ends: ${new Date(sub.trial_ends_at).toLocaleDateString()}</div>`
          : '';
        card.innerHTML = `
          <div class="sub-card-main">
            <h3 class="sub-name">${escapeHtml(sub.name)}</h3>
            <p class="sub-vendor">${escapeHtml(sub.vendor)}</p>
            <p class="sub-description">${escapeHtml(sub.description || '')}</p>
            <div class="sub-meta">
              <span class="sub-chip">${escapeHtml(sub.category)}</span>
              <span class="sub-status ${sub.status}">${sub.status === 'trial' ? 'Trial' : 'Active'}</span>
            </div>
            ${trialWarning}
          </div>
          <div class="sub-card-right">
            <div class="sub-price">${sub.price}${sub.currency}</div>
            <div class="sub-monthly">≈ ${(sub.monthly_equiv || 0).toFixed(2)}/mo</div>
          </div>
        `;
        contentDiv.appendChild(card);
      }

      // Toggle collapse on month header click
      const header = section.querySelector('.month-header');
      const expandText = header.querySelector('div:last-child');
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        const isCollapsed = contentDiv.style.display === 'none';
        contentDiv.style.display = isCollapsed ? 'block' : 'none';
        expandText.innerHTML = isCollapsed ? '↓ collapse' : '↑ expand';
      });

      listDiv.appendChild(section);
    }
  }

  // Load and render breakdown
  async function loadBreakdown() {
    const data = await apiCall('GET', '/api/summary');
    const summaryDiv = document.getElementById('summary');
    const catDiv = document.getElementById('categories');
    summaryDiv.innerHTML = '';
    catDiv.innerHTML = '';
    if (!data) return;

    // Monthly summary by currency
    const byCurr = data.byCurrency || {};
    const summaryHeader = document.createElement('div');
    summaryHeader.innerHTML = '<h3 style="margin-top: 0; margin-bottom: 16px;">Monthly Total by Currency</h3>';
    summaryDiv.appendChild(summaryHeader);

    if (Object.keys(byCurr).length === 0) {
      summaryDiv.innerHTML = '<div class="empty">No active subscriptions</div>';
      return;
    }

    for (const [curr, stats] of Object.entries(byCurr)) {
      const item = document.createElement('div');
      item.className = 'summary-item';
      item.innerHTML = `
        <div class="summary-label">${curr}</div>
        <div class="summary-value">${(stats.monthly || 0).toFixed(2)}</div>
        <div class="summary-label">${stats.count} subscription${stats.count > 1 ? 's' : ''}</div>
      `;
      summaryDiv.appendChild(item);
    }

    // Category breakdown (grouped by category, separated by currency)
    const byCat = data.byCategory || [];
    const catHeader = document.createElement('div');
    catHeader.innerHTML = '<h3 style="margin-top: 24px; margin-bottom: 16px;">By Service Category (per Currency)</h3>';
    catDiv.appendChild(catHeader);

    if (byCat.length === 0) {
      catDiv.appendChild(document.createElement('div')).innerHTML = '<div class="empty">No categories</div>';
      return;
    }

    // Group by category name, then show each currency separately
    const groupedByCat = {};
    for (const item of byCat) {
      if (!groupedByCat[item.category]) groupedByCat[item.category] = [];
      groupedByCat[item.category].push(item);
    }

    for (const [catName, items] of Object.entries(groupedByCat)) {
      // Category header
      const catSection = document.createElement('div');
      catSection.innerHTML = `<div style="font-weight: 600; margin-top: 16px; margin-bottom: 8px; font-size: 14px;">${escapeHtml(catName)}</div>`;
      catDiv.appendChild(catSection);

      // Each currency within this category
      for (const item of items) {
        const card = document.createElement('div');
        card.className = 'category-card';
        card.style.marginLeft = '16px';
        card.innerHTML = `
          <span class="category-name">${escapeHtml(item.currency)}</span>
          <div class="category-stats">
            <div class="category-monthly">${(item.monthly || 0).toFixed(2)} ${item.currency}/mo</div>
            <div class="category-count">${item.count} subscription${item.count > 1 ? 's' : ''}</div>
          </div>
        `;
        catDiv.appendChild(card);
      }
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      e.target.classList.add('active');
      const tab = e.target.dataset.tab;
      document.getElementById(tab).classList.add('active');
      if (tab === 'breakdown') loadBreakdown();
    });
  });

  // Scan button — trigger isolated agent scan
  document.getElementById('scanBtn').addEventListener('click', async () => {
    const btn = document.getElementById('scanBtn');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    try {
      const res = await apiCall('POST', '/api/trigger-scan');
      if (res.ok) {
        alert('Scan triggered — agent is now processing your inbox');
        // Reload data after a few seconds (agent takes time to run)
        setTimeout(() => {
          loadList();
          document.querySelector('.tab-btn.active').click(); // Re-trigger active tab
        }, 3000);
      }
    } catch (err) {
      alert(`Error: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan Inbox';
    }
  });

  // Initial load
  loadList();
})();
