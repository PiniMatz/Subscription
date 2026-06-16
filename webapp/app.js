(function () {
  'use strict';

  // Get authentication token from injected global or session storage
  let token = window.AUTH_TOKEN || sessionStorage.getItem('auth-token');
  const isStaticMode = window.location.hostname.includes('github.io') || !token;

  if (!token && !isStaticMode) {
    alert('Authentication error: No session token provided.');
    return;
  }
  if (token) {
    sessionStorage.setItem('auth-token', token);
  }

  const baseUrl = window.location.origin;

  // Local currency conversion rates (baseline: USD) for category progress calculations
  const CONVERSION_RATES = {
    'USD': 1.0,
    'ILS': 0.28,
    'EUR': 1.08,
    'GBP': 1.28
  };

  // State cache for filters and active data
  let allSubscriptions = [];
  let deleteTargetId = null;

  // --- API CALL UTILITY ---
  async function apiCall(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
    };
    if (body) opts.body = JSON.stringify(body);
    try {
      const res = await fetch(baseUrl + path, opts);
      if (res.status === 401) {
        sessionStorage.removeItem('auth-token');
        location.reload();
        return null;
      }
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      showToast(err.message, 'error');
      throw err;
    }
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'fa-circle-check';
    if (type === 'error') icon = 'fa-circle-exclamation';
    if (type === 'info') icon = 'fa-circle-info';

    toast.innerHTML = `
      <i class="fa-solid ${icon}"></i>
      <div style="flex: 1;">${escapeHtml(message)}</div>
    `;
    container.appendChild(toast);

    // Fade out and remove
    setTimeout(() => {
      toast.classList.add('toast-fadeout');
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, 4500);
  }

  // --- DATA LOADING & CALCULATIONS ---
  async function loadDashboardData() {
    try {
      if (isStaticMode) {
        const res = await fetch('./subscriptions.json');
        allSubscriptions = await res.json();
        renderSubscriptionsList();
        renderRenewalsTimeline();
        calculateAndRenderStaticSummaries();
        setupStaticUI();
      } else {
        allSubscriptions = await apiCall('GET', '/api/subscriptions');
        renderSubscriptionsList();
        renderRenewalsTimeline();
        await loadSummaries();
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      if (isStaticMode) {
        showToast("Failed to load subscriptions.json.", "error");
      }
    }
  }

  function calculateAndRenderStaticSummaries() {
    const summaryDiv = document.getElementById('summary');
    summaryDiv.innerHTML = '';
    
    const byCurrency = {};
    allSubscriptions.forEach(s => {
      byCurrency[s.currency] = byCurrency[s.currency] || { monthly: 0, count: 0 };
      byCurrency[s.currency].monthly += (s.monthly_equiv || 0);
      byCurrency[s.currency].count += 1;
    });

    if (Object.keys(byCurrency).length === 0) {
      summaryDiv.innerHTML = '<div class="empty-state" style="padding: 10px;"><p style="font-size:12px;">No active subscriptions</p></div>';
      return;
    }

    for (const [curr, stats] of Object.entries(byCurrency)) {
      const card = document.createElement('div');
      card.className = 'summary-card';
      card.innerHTML = `
        <div class="summary-currency">${curr} Total</div>
        <div class="summary-amount">${formatCurrencyValue(stats.monthly, curr)}</div>
        <div class="summary-count">${stats.count} subscription${stats.count !== 1 ? 's' : ''}</div>
      `;
      summaryDiv.appendChild(card);
    }
    
    renderCategoryBudgets();
  }

  function setupStaticUI() {
    const addBtn = document.getElementById('addBtn');
    if (addBtn) addBtn.style.display = 'none';

    const scanBtn = document.getElementById('scanBtn');
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.style.opacity = '0.5';
      scanBtn.style.cursor = 'not-allowed';
      scanBtn.querySelector('span').textContent = 'Scan Disabled (Static)';
    }

    const statusCard = document.querySelector('.scanner-status-card');
    if (statusCard) {
      const indicator = statusCard.querySelector('.status-indicator');
      indicator.innerHTML = `
        <span class="pulse-dot" style="background:#6366f1; box-shadow:0 0 10px #6366f1; animation:none;"></span>
        <span class="status-text">GitHub Pages (Read-Only)</span>
      `;
      statusCard.querySelector('.status-subtext').textContent = 'To edit data, run the application server locally.';
    }
  }

  async function loadSummaries() {
    const data = await apiCall('GET', '/api/summary');
    if (!data) return;

    // 1. Render Monthly Spending Cards
    const summaryDiv = document.getElementById('summary');
    summaryDiv.innerHTML = '';
    const byCurr = data.byCurrency || {};

    if (Object.keys(byCurr).length === 0) {
      summaryDiv.innerHTML = '<div class="empty-state" style="padding: 10px;"><p style="font-size:12px;">No active subscriptions</p></div>';
      return;
    }

    for (const [curr, stats] of Object.entries(byCurr)) {
      const card = document.createElement('div');
      card.className = 'summary-card';
      card.innerHTML = `
        <div class="summary-currency">${curr} Total</div>
        <div class="summary-amount">${formatCurrencyValue(stats.monthly, curr)}</div>
        <div class="summary-count">${stats.count} subscription${stats.count !== 1 ? 's' : ''}</div>
      `;
      summaryDiv.appendChild(card);
    }

    // 2. Render Sidebar Category Budget Progress Bars
    renderCategoryBudgets();
  }

  // Compute category spend and draw progress bars relative to total spend in USD equivalent
  function renderCategoryBudgets() {
    const budgetList = document.getElementById('categoryBudgets');
    if (!budgetList) return;
    budgetList.innerHTML = '';

    const categorySpendUSD = {};
    let totalSpendUSD = 0;

    // Sum active subscriptions converted to USD
    allSubscriptions.forEach(sub => {
      if (sub.status !== 'active') return;
      const rate = CONVERSION_RATES[sub.currency] || 1.0;
      const spendUSD = (sub.monthly_equiv || 0) * rate;
      
      categorySpendUSD[sub.category] = (categorySpendUSD[sub.category] || 0) + spendUSD;
      totalSpendUSD += spendUSD;
    });

    if (totalSpendUSD === 0) {
      budgetList.innerHTML = '<div class="empty-state" style="padding: 10px;"><p style="font-size:12px;">No active budget allocations</p></div>';
      return;
    }

    // Sort categories by spend descending
    const sortedCategories = Object.entries(categorySpendUSD).sort((a, b) => b[1] - a[1]);

    sortedCategories.forEach(([catName, spendUSD]) => {
      const percentage = Math.round((spendUSD / totalSpendUSD) * 100);
      const budgetItem = document.createElement('div');
      budgetItem.className = 'budget-item';
      budgetItem.innerHTML = `
        <div class="budget-labels">
          <span class="budget-name">${escapeHtml(catName)}</span>
          <span class="budget-value">${percentage}% ($${spendUSD.toFixed(1)})</span>
        </div>
        <div class="progress-track">
          <div class="progress-bar" style="width: ${percentage}%"></div>
        </div>
      `;
      budgetList.appendChild(budgetItem);
    });
  }

  // --- RENDER SUBSCRIPTIONS LIST (Grouped by Month) ---
  function renderSubscriptionsList() {
    const listDiv = document.getElementById('subsList');
    if (!listDiv) return;
    listDiv.innerHTML = '';

    // Apply client-side filters
    const searchVal = document.getElementById('searchInput').value.toLowerCase();
    const catVal = document.getElementById('categoryFilter').value;
    const cycleVal = document.getElementById('cycleFilter').value;
    const statusVal = document.getElementById('statusFilter').value;

    const filtered = allSubscriptions.filter(sub => {
      const matchesSearch = sub.name.toLowerCase().includes(searchVal) || 
                            sub.vendor.toLowerCase().includes(searchVal) || 
                            (sub.description && sub.description.toLowerCase().includes(searchVal));
      const matchesCategory = !catVal || sub.category === catVal;
      const matchesCycle = !cycleVal || sub.cycle.toLowerCase() === cycleVal.toLowerCase();
      const matchesStatus = !statusVal || sub.status.toLowerCase() === statusVal.toLowerCase();

      return matchesSearch && matchesCategory && matchesCycle && matchesStatus;
    });

    if (filtered.length === 0) {
      listDiv.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-folder-open"></i>
          <h3>No subscriptions found</h3>
          <p>Try modifying your search query or filter options.</p>
        </div>
      `;
      return;
    }

    // Group by month
    const months = {};
    filtered.forEach(sub => {
      const dateStr = sub.started_at || sub.created_at;
      const date = new Date(dateStr);
      // Fallback if date is invalid
      const monthKey = isNaN(date.getTime())
        ? 'Active Subscriptions'
        : date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
        
      if (!months[monthKey]) months[monthKey] = [];
      months[monthKey].push(sub);
    });

    // Sort month categories chronologically (reversed: newer month first)
    const sortedMonths = Object.keys(months).sort((a, b) => {
      if (a === 'Active Subscriptions') return 1;
      if (b === 'Active Subscriptions') return -1;
      return new Date(b) - new Date(a);
    });

    sortedMonths.forEach(monthKey => {
      const monthSubs = months[monthKey];
      const section = document.createElement('section');
      section.className = 'month-section';

      // Sum up month totals (group by currency if multiple, else single)
      const currencyTotals = {};
      monthSubs.forEach(s => {
        currencyTotals[s.currency] = (currencyTotals[s.currency] || 0) + (s.monthly_equiv || 0);
      });
      const totalStr = Object.entries(currencyTotals)
        .map(([curr, total]) => `${formatCurrencyValue(total, curr)}/mo`)
        .join(' + ');

      section.innerHTML = `
        <div class="month-header">
          <h3>${monthKey} <span class="count">(${monthSubs.length})</span></h3>
          <div class="month-header-details">
            <span class="month-total">${totalStr}</span>
            <button class="month-toggle-btn" data-collapsed="false">
              <i class="fa-solid fa-angle-up"></i>
              <span>Collapse</span>
            </button>
          </div>
        </div>
        <div class="month-content"></div>
      `;

      const contentDiv = section.querySelector('.month-content');
      monthSubs.forEach(sub => {
        const card = document.createElement('div');
        card.className = 'sub-card';
        
        const trialWarning = sub.status === 'trial' && sub.trial_ends_at
          ? `<div class="trial-alert-bar">
              <i class="fa-solid fa-hourglass-half"></i>
              <span>Trial ends: ${new Date(sub.trial_ends_at).toLocaleDateString()}</span>
             </div>`
          : '';

        const badgeClass = sub.status === 'trial' ? 'badge-status-trial' : 'badge-status-active';
        const badgeLabel = sub.status === 'trial' ? 'Trial' : 'Active';

        const actionButtons = isStaticMode
          ? ''
          : `<button class="btn-icon edit-sub-btn" data-id="${sub.id}" title="Edit subscription"><i class="fa-solid fa-pen-to-square"></i></button>
             <button class="btn-icon btn-icon-danger delete-sub-btn" data-id="${sub.id}" data-name="${escapeHtml(sub.name)}" title="Delete subscription"><i class="fa-solid fa-trash-can"></i></button>`;

        card.innerHTML = `
          <div class="sub-card-header">
            <div class="sub-info">
              <h4 class="sub-name">${escapeHtml(sub.name)}</h4>
              <span class="sub-vendor">${escapeHtml(sub.vendor)}</span>
            </div>
            <div class="sub-pricing">
              <div class="sub-price">${formatCurrencyValue(sub.price, sub.currency)}</div>
              <div class="sub-period">per ${sub.cycle}</div>
            </div>
          </div>
          <div class="sub-card-body">
            <p>${escapeHtml(sub.description || 'No description provided.')}</p>
            ${trialWarning}
          </div>
          <div class="sub-card-footer">
            <div class="sub-badges">
              <span class="badge badge-category">${escapeHtml(sub.category)}</span>
              <span class="badge ${badgeClass}">${badgeLabel}</span>
            </div>
            <div class="sub-actions">
              ${sub.url ? `<a href="${escapeHtml(sub.url)}" target="_blank" class="btn-icon btn-icon-primary" title="Visit website"><i class="fa-solid fa-globe"></i></a>` : ''}
              ${actionButtons}
            </div>
          </div>
        `;
        contentDiv.appendChild(card);
      });

      // Collapse toggle event listener
      const toggleBtn = section.querySelector('.month-toggle-btn');
      toggleBtn.addEventListener('click', () => {
        const isCollapsed = toggleBtn.getAttribute('data-collapsed') === 'true';
        if (isCollapsed) {
          contentDiv.style.display = 'grid';
          toggleBtn.setAttribute('data-collapsed', 'false');
          toggleBtn.innerHTML = '<i class="fa-solid fa-angle-up"></i> <span>Collapse</span>';
        } else {
          contentDiv.style.display = 'none';
          toggleBtn.setAttribute('data-collapsed', 'true');
          toggleBtn.innerHTML = '<i class="fa-solid fa-angle-down"></i> <span>Expand</span>';
        }
      });

      listDiv.appendChild(section);
    });

    // Wire up Edit & Delete button actions
    document.querySelectorAll('.edit-sub-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = parseInt(e.currentTarget.dataset.id);
        openEditModal(id);
      });
    });

    document.querySelectorAll('.delete-sub-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        deleteTargetId = parseInt(e.currentTarget.dataset.id);
        document.getElementById('deleteSubName').textContent = e.currentTarget.dataset.name;
        openModal('deleteModal');
      });
    });
  }

  // --- RENDER RENEWALS TIMELINE ---
  function renderRenewalsTimeline() {
    const timelineList = document.getElementById('timelineList');
    if (!timelineList) return;
    timelineList.innerHTML = '';

    const today = new Date();
    today.setHours(0,0,0,0);

    const upcomingCharges = [];

    allSubscriptions.forEach(sub => {
      let chargeDate = null;

      // Use next_charge_at if set explicitly
      if (sub.next_charge_at) {
        chargeDate = new Date(sub.next_charge_at);
      } else if (sub.status === 'trial' && sub.trial_ends_at) {
        // Trials charge on end date
        chargeDate = new Date(sub.trial_ends_at);
      } else if (sub.started_at) {
        // Calculate based on cycle
        const start = new Date(sub.started_at);
        chargeDate = new Date(start);

        // Advance charge date until it is >= today
        while (chargeDate < today) {
          if (sub.cycle.toLowerCase() === 'weekly') {
            chargeDate.setDate(chargeDate.getDate() + 7);
          } else if (sub.cycle.toLowerCase() === 'monthly') {
            chargeDate.setMonth(chargeDate.getMonth() + 1);
          } else if (sub.cycle.toLowerCase() === 'quarterly') {
            chargeDate.setMonth(chargeDate.getMonth() + 3);
          } else if (sub.cycle.toLowerCase() === 'yearly') {
            chargeDate.setFullYear(chargeDate.getFullYear() + 1);
          } else {
            // One-off doesn't repeat
            break;
          }
        }
      }

      // Check if within next 60 days
      if (chargeDate && !isNaN(chargeDate.getTime()) && chargeDate >= today) {
        const diffDays = Math.ceil((chargeDate - today) / (1000 * 60 * 60 * 24));
        if (diffDays <= 60) {
          upcomingCharges.push({
            subscription: sub,
            date: chargeDate,
            daysRemaining: diffDays
          });
        }
      }
    });

    // Sort upcoming charges chronologically
    upcomingCharges.sort((a, b) => a.date - b.date);

    if (upcomingCharges.length === 0) {
      timelineList.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-calendar-xmark"></i>
          <h3>No upcoming renewals</h3>
          <p>No renewals found in the next 60 days. Ensure start dates are configured.</p>
        </div>
      `;
      return;
    }

    // Group by Date for cleaner presentation
    const groupedByDate = {};
    upcomingCharges.forEach(item => {
      const key = item.date.toISOString().substring(0, 10);
      if (!groupedByDate[key]) groupedByDate[key] = [];
      groupedByDate[key].push(item);
    });

    for (const [dateStr, items] of Object.entries(groupedByDate)) {
      const d = new Date(dateStr);
      const isToday = d.getTime() === today.getTime();
      const dateLabel = isToday 
        ? "Today" 
        : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      
      const timelineItem = document.createElement('div');
      timelineItem.className = `timeline-item ${isToday ? 'today' : ''}`;
      
      let relativeLabel = "";
      if (isToday) {
        relativeLabel = " — Charging today!";
      } else {
        const days = items[0].daysRemaining;
        relativeLabel = ` — in ${days} day${days !== 1 ? 's' : ''}`;
      }

      timelineItem.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-date">${dateLabel}<span style="font-weight: 500; font-size:12px; color: var(--text-sub);">${relativeLabel}</span></div>
        <div class="timeline-cards"></div>
      `;

      const cardsContainer = timelineItem.querySelector('.timeline-cards');
      items.forEach(item => {
        const s = item.subscription;
        const card = document.createElement('div');
        card.className = 'timeline-card';
        card.innerHTML = `
          <div class="timeline-card-info">
            <span class="timeline-card-name">${escapeHtml(s.name)}</span>
            <span class="timeline-card-desc">${escapeHtml(s.vendor)} &bull; ${escapeHtml(s.category)}</span>
          </div>
          <div class="timeline-card-price">
            <div class="timeline-price-value">${formatCurrencyValue(s.price, s.currency)}</div>
            <div class="timeline-cycle-value">Renewal: ${s.cycle}</div>
          </div>
        `;
        cardsContainer.appendChild(card);
      });

      timelineList.appendChild(timelineItem);
    }
  }

  // --- CRUD ACTIONS ---

  // Create
  document.getElementById('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: document.getElementById('addName').value,
      vendor: document.getElementById('addVendor').value,
      category: document.getElementById('addCategory').value,
      cycle: document.getElementById('addCycle').value,
      price: parseFloat(document.getElementById('addPrice').value),
      currency: document.getElementById('addCurrency').value,
      status: document.getElementById('addStatus').value,
      started_at: document.getElementById('addStartedAt').value || null,
      trial_ends_at: document.getElementById('addTrialEndsAt').value || null,
      next_charge_at: document.getElementById('addNextCharge').value || null,
      url: document.getElementById('addUrl').value || null,
      description: document.getElementById('addDescription').value || null,
      notes: document.getElementById('addNotes').value || null,
    };

    try {
      const res = await apiCall('POST', '/api/subscriptions', body);
      if (res.ok) {
        showToast('Subscription added successfully!', 'success');
        closeModal('addModal');
        document.getElementById('addForm').reset();
        document.getElementById('trialEndsGroup').style.display = 'none';
        loadDashboardData();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Edit (Open Modal with Prepopulated Data)
  function openEditModal(id) {
    const sub = allSubscriptions.find(s => s.id === id);
    if (!sub) return;

    document.getElementById('editId').value = sub.id;
    document.getElementById('editName').value = sub.name;
    document.getElementById('editVendor').value = sub.vendor;
    document.getElementById('editCategory').value = sub.category;
    document.getElementById('editCycle').value = sub.cycle;
    document.getElementById('editPrice').value = sub.price;
    document.getElementById('editCurrency').value = sub.currency;
    document.getElementById('editStatus').value = sub.status;
    document.getElementById('editStartedAt').value = sub.started_at || '';
    document.getElementById('editTrialEndsAt').value = sub.trial_ends_at || '';
    document.getElementById('editNextCharge').value = sub.next_charge_at || '';
    document.getElementById('editUrl').value = sub.url || '';
    document.getElementById('editDescription').value = sub.description || '';
    document.getElementById('editNotes').value = sub.notes || '';

    // Show or hide trial end date group
    const trialGroup = document.getElementById('editTrialEndsGroup');
    trialGroup.style.display = sub.status === 'trial' ? 'flex' : 'none';

    openModal('editModal');
  }

  // Update
  document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editId').value;
    const body = {
      name: document.getElementById('editName').value,
      vendor: document.getElementById('editVendor').value,
      category: document.getElementById('editCategory').value,
      cycle: document.getElementById('editCycle').value,
      price: parseFloat(document.getElementById('editPrice').value),
      currency: document.getElementById('editCurrency').value,
      status: document.getElementById('editStatus').value,
      started_at: document.getElementById('editStartedAt').value || null,
      trial_ends_at: document.getElementById('editTrialEndsAt').value || null,
      next_charge_at: document.getElementById('editNextCharge').value || null,
      url: document.getElementById('editUrl').value || null,
      description: document.getElementById('editDescription').value || null,
      notes: document.getElementById('editNotes').value || null,
    };

    try {
      const res = await apiCall('PUT', `/api/subscriptions/${id}`, body);
      if (res.ok) {
        showToast('Subscription updated successfully!', 'success');
        closeModal('editModal');
        loadDashboardData();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // Delete
  document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!deleteTargetId) return;
    try {
      const res = await apiCall('DELETE', `/api/subscriptions/${deleteTargetId}`);
      if (res.ok) {
        showToast('Subscription deleted successfully.', 'success');
        closeModal('deleteModal');
        deleteTargetId = null;
        loadDashboardData();
      }
    } catch (err) {
      console.error(err);
    }
  });

  // --- INTERACTION HANDLERS ---

  // Gmail scanning trigger
  document.getElementById('scanBtn').addEventListener('click', async () => {
    const btn = document.getElementById('scanBtn');
    const icon = btn.querySelector('i');
    const text = btn.querySelector('span');

    btn.disabled = true;
    text.textContent = 'Scanning...';
    icon.className = 'fa-solid fa-circle-notch fa-spin';

    try {
      const res = await apiCall('POST', '/api/trigger-scan');
      if (res.ok) {
        if (res.found) {
          showToast(res.message, 'success');
        } else {
          showToast(res.message, 'info');
        }
        await loadDashboardData();
      }
    } catch (err) {
      console.error("Scan error:", err);
    } finally {
      btn.disabled = false;
      text.textContent = 'Scan Inbox';
      icon.className = 'fa-solid fa-rotate';
    }
  });

  // Toggle trial input visibility on status changes
  document.getElementById('addStatus').addEventListener('change', (e) => {
    const trialGroup = document.getElementById('trialEndsGroup');
    trialGroup.style.display = e.target.value === 'trial' ? 'flex' : 'none';
  });

  document.getElementById('editStatus').addEventListener('change', (e) => {
    const trialGroup = document.getElementById('editTrialEndsGroup');
    trialGroup.style.display = e.target.value === 'trial' ? 'flex' : 'none';
  });

  // Search & Filter event listeners
  document.getElementById('searchInput').addEventListener('input', renderSubscriptionsList);
  document.getElementById('categoryFilter').addEventListener('change', renderSubscriptionsList);
  document.getElementById('cycleFilter').addEventListener('change', renderSubscriptionsList);
  document.getElementById('statusFilter').addEventListener('change', renderSubscriptionsList);

  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('categoryFilter').value = '';
    document.getElementById('cycleFilter').value = '';
    document.getElementById('statusFilter').value = '';
    renderSubscriptionsList();
    showToast('Filters cleared.', 'info');
  });

  // Modal Open/Close helpers
  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('open');
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
  }

  document.getElementById('addBtn').addEventListener('click', () => openModal('addModal'));

  // Wire up close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      closeModal(btn.dataset.close);
    });
  });

  // Close modals on clicking backdrop
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      e.target.classList.remove('open');
    }
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      e.currentTarget.classList.add('active');
      const tabId = e.currentTarget.dataset.tab;
      document.getElementById(tabId).classList.add('active');
    });
  });

  // --- FORMATTING UTILITIES ---
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatCurrencyValue(value, currency) {
    const val = Number(value);
    const symbols = {
      'USD': '$',
      'ILS': '₪',
      'EUR': '€',
      'GBP': '£'
    };
    const symbol = symbols[currency] || currency + ' ';
    return `${symbol}${val.toFixed(2)}`;
  }

  // --- INITIAL LOAD ---
  loadDashboardData();
})();
