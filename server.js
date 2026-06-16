const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = "demo-session-token-2026";

// Path to SQLite Database
const dbPath = path.join(__dirname, 'data', 'subs.sqlite');
console.log("Connecting to SQLite database at:", dbPath);
let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  console.error("Failed to connect to SQLite DB:", err.message);
  process.exit(1);
}

// Middleware
app.use(express.json());

// Token authorization middleware for API routes
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
}

// Convert payment cycle to monthly equivalent multiplier
function calculateMonthlyEquiv(price, cycle) {
  const cycles = {
    'weekly': 52 / 12,
    'monthly': 1.0,
    'quarterly': 4 / 12,
    'yearly': 1 / 12,
    'oneoff': 0.0,
  };
  const multiplier = cycles[cycle.toLowerCase()] !== undefined ? cycles[cycle.toLowerCase()] : 1.0;
  return price * multiplier;
}

// Serve static webapp files but inject AUTH_TOKEN in index.html first
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'webapp', 'index.html');
  try {
    let html = fs.readFileSync(indexPath, 'utf8');
    const tokenScript = `<script>window.AUTH_TOKEN = "${AUTH_TOKEN}";</script>`;
    // Inject before the closing </head> tag
    html = html.replace('</head>', `${tokenScript}\n</head>`);
    res.send(html);
  } catch (err) {
    res.status(500).send("Error reading index.html: " + err.message);
  }
});

// Serve other static assets normally
app.use(express.static(path.join(__dirname, 'webapp')));

// --- API ROUTES (Protected) ---

// 1. Get all subscriptions
app.get('/api/subscriptions', authMiddleware, (req, res) => {
  try {
    const stmt = db.prepare("SELECT * FROM subscriptions ORDER BY started_at DESC");
    const rows = stmt.all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Add a subscription
app.post('/api/subscriptions', authMiddleware, (req, res) => {
  try {
    const { name, vendor, category, description, price, currency, cycle, status, started_at, trial_ends_at, next_charge_at, url, notes } = req.body;
    
    if (!name || !vendor || !category || price === undefined || price === null || !cycle) {
      return res.status(400).json({ error: "Missing required fields: name, vendor, category, price, cycle" });
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: "Invalid price value" });
    }

    const monthly_equiv = calculateMonthlyEquiv(priceNum, cycle);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const stmt = db.prepare(`
      INSERT INTO subscriptions
      (name, vendor, category, description, price, currency, cycle, monthly_equiv, status, started_at, trial_ends_at, next_charge_at, url, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      name, vendor, category, description || null, priceNum, currency || 'USD', cycle, monthly_equiv, 
      status || 'active', started_at || null, trial_ends_at || null, next_charge_at || null, url || null, notes || null, 
      now, now
    );

    res.json({ ok: true, message: "Subscription added successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Edit a subscription
app.put('/api/subscriptions/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const { name, vendor, category, description, price, currency, cycle, status, started_at, trial_ends_at, next_charge_at, url, notes } = req.body;
    
    if (!name || !vendor || !category || price === undefined || price === null || !cycle) {
      return res.status(400).json({ error: "Missing required fields: name, vendor, category, price, cycle" });
    }

    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: "Invalid price value" });
    }

    const monthly_equiv = calculateMonthlyEquiv(priceNum, cycle);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const stmt = db.prepare(`
      UPDATE subscriptions
      SET name = ?, vendor = ?, category = ?, description = ?, price = ?, currency = ?, cycle = ?, monthly_equiv = ?, status = ?, started_at = ?, trial_ends_at = ?, next_charge_at = ?, url = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(
      name, vendor, category, description || null, priceNum, currency || 'USD', cycle, monthly_equiv, 
      status, started_at || null, trial_ends_at || null, next_charge_at || null, url || null, notes || null, 
      now, parseInt(id)
    );

    res.json({ ok: true, message: "Subscription updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete a subscription
app.delete('/api/subscriptions/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare("DELETE FROM subscriptions WHERE id = ?");
    stmt.run(parseInt(id));
    res.json({ ok: true, message: "Subscription deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get summary statistics
app.get('/api/summary', authMiddleware, (req, res) => {
  try {
    const byCurrRows = db.prepare(`
      SELECT currency, SUM(monthly_equiv) as monthly, COUNT(*) as count
      FROM subscriptions
      GROUP BY currency
    `).all();
    
    const byCurrency = {};
    for (const r of byCurrRows) {
      byCurrency[r.currency] = {
        monthly: Number(r.monthly),
        count: Number(r.count)
      };
    }
    
    const byCatRows = db.prepare(`
      SELECT category, currency, SUM(monthly_equiv) as monthly, COUNT(*) as count
      FROM subscriptions
      GROUP BY category, currency
    `).all();
    
    const byCategory = byCatRows.map(r => ({
      category: r.category,
      currency: r.currency,
      monthly: Number(r.monthly),
      count: Number(r.count)
    }));
    
    res.json({ byCurrency, byCategory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mock inbox subscriptions pool for trigger-scan demo
const mockPool = [
  { name: "ChatGPT Plus", vendor: "OpenAI", category: "Software/SaaS", price: 20.00, currency: "USD", cycle: "monthly", description: "AI research assistant", status: "active", url: "https://chatgpt.com", notes: "Scanned from OpenAI receipt" },
  { name: "YouTube Premium", vendor: "YouTube", category: "Streaming", price: 13.99, currency: "USD", cycle: "monthly", description: "Ad-free video streaming", status: "active", url: "https://youtube.com", notes: "Scanned from Google Billing" },
  { name: "Disney+ Standard", vendor: "Disney+", category: "Streaming", price: 13.99, currency: "USD", cycle: "monthly", description: "Disney movies and series", status: "active", url: "https://disneyplus.com", notes: "Scanned from Disney Receipt" },
  { name: "Adobe Creative Cloud", vendor: "Adobe", category: "Software/SaaS", price: 54.99, currency: "USD", cycle: "monthly", description: "Creative design tools", status: "active", url: "https://adobe.com", notes: "Scanned from Adobe Invoice" },
  { name: "Amazon Prime", vendor: "Amazon", category: "Utilities", price: 14.99, currency: "USD", cycle: "monthly", description: "Prime shopping and video", status: "active", url: "https://amazon.com", notes: "Scanned from Amazon Invoice" },
  { name: "GitHub Copilot", vendor: "GitHub", category: "Software/SaaS", price: 10.00, currency: "USD", cycle: "monthly", description: "AI pair programming helper", status: "active", url: "https://github.com", notes: "Scanned from GitHub Receipt" },
  { name: "Microsoft 365 Personal", vendor: "Microsoft", category: "Software/SaaS", price: 69.99, currency: "USD", cycle: "yearly", description: "Office tools and 1TB storage", status: "active", url: "https://office.com", notes: "Scanned from Microsoft Account Store" },
  { name: "DuoLingo Super", vendor: "DuoLingo", category: "Software/SaaS", price: 29.90, currency: "ILS", cycle: "monthly", description: "Language learning subscription", status: "trial", trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10), notes: "Trial subscription" }
];

// 6. Trigger scanning (mocked)
app.post('/api/trigger-scan', authMiddleware, (req, res) => {
  try {
    // 1. Get existing vendors in database
    const existingVendors = new Set(
      db.prepare("SELECT vendor FROM subscriptions").all().map(r => r.vendor.toLowerCase())
    );

    // 2. Find first item in mockPool that is not in db
    const nextMock = mockPool.find(item => !existingVendors.has(item.vendor.toLowerCase()));

    if (!nextMock) {
      return res.json({ ok: true, found: false, message: "No new subscription emails found. Your database is up to date!" });
    }

    // 3. Insert mock subscription
    const monthly_equiv = calculateMonthlyEquiv(nextMock.price, nextMock.cycle);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const started_at = new Date().toISOString().substring(0, 10); // Today

    const insertStmt = db.prepare(`
      INSERT INTO subscriptions
      (name, vendor, category, description, price, currency, cycle, monthly_equiv, status, started_at, trial_ends_at, url, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      nextMock.name, nextMock.vendor, nextMock.category, nextMock.description, nextMock.price, nextMock.currency, nextMock.cycle, 
      monthly_equiv, nextMock.status, started_at, nextMock.trial_ends_at || null, nextMock.url || null, nextMock.notes || null, 
      now, now
    );

    // 4. Update email_state
    const stateStmt = db.prepare("SELECT seen_ids FROM email_state WHERE id = 1");
    const stateRow = stateStmt.all()[0];
    const currentSeenIds = JSON.parse(stateRow && stateRow.seen_ids ? stateRow.seen_ids : '[]');
    
    const mockEmailId = "mock_msg_" + Math.random().toString(36).substring(2, 11);
    currentSeenIds.push(mockEmailId);

    const updateStateStmt = db.prepare(`
      UPDATE email_state
      SET last_scanned_ts = ?, seen_ids = ?
      WHERE id = 1
    `);
    updateStateStmt.run(new Date().toISOString(), JSON.stringify(currentSeenIds));

    // Wait a brief simulated scanner time
    setTimeout(() => {
      res.json({
        ok: true,
        found: true,
        message: `Found subscription for ${nextMock.name} (${nextMock.price} ${nextMock.currency})!`,
        subscription: nextMock
      });
    }, 1500); // 1.5 seconds latency to feel like a real scan
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Subscriptions Tracker Server is running on port ${PORT}`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
