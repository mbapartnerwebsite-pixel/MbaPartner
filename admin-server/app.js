require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./lib/db');
const { ensureAdminSeeded } = require('./lib/auth');
const { run: seed } = require('./seed');
const { makePublicRouter, makePublicWriteRouter, makeAdminRouter, COLLECTIONS, ADMIN_ONLY, PUBLIC_WRITE_ONLY } = require('./routes/resource');
const razorpayRouter = require('./routes/razorpay');
const settingsRouter = require('./routes/settings');
const couponsRouter = require('./routes/coupons');
const authRouter = require('./routes/auth');
const { router: uploadRouter, UPLOAD_DIR } = require('./routes/upload');
const bulkQuestionsRouter = require('./routes/bulk-questions');
const catAttemptsRouter = require('./routes/cat-attempts');
const referralsRoutes = require('./routes/referrals');
const studentsPublicRouter = require('./routes/students-public');

async function start() {
  // Connect to MongoDB (or fall back to the local file) BEFORE seeding --
  // seed()/backfillMissingCollections() read+write through db.js and must
  // see the real persisted data, not an empty in-memory cache.
  await db.connect();

  // First boot: create the store with the site's own sample data so nothing
  // changes visually until the admin actually edits something.
  seed(false);
  ensureAdminSeeded();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // ---- Public API (read-only, no login needed -- the live website calls these) ----
  // A handful of collections (leads, mentor applications, orders, etc.) are
  // write-only on the public side instead -- visitors can submit into them,
  // but only the logged-in admin can read the list back.
  COLLECTIONS.forEach(function (name) {
    if (ADMIN_ONLY.has(name)) return;
    if (name === 'catAttempts') return; // custom router below (scoped reads + duplicate-attempt check)
    if (name === 'students') return; // custom router below (strips Password, adds login/change-password)
    if (PUBLIC_WRITE_ONLY.has(name)) app.use('/api/public/' + name, makePublicWriteRouter(name));
    else app.use('/api/public/' + name, makePublicRouter(name));
  });
  app.use('/api/public/settings', settingsRouter); // GET is public; PUT inside requires auth
  app.use('/api/public/coupons', couponsRouter); // exposes POST /api/public/coupons/validate
  app.use('/api/public/razorpay', razorpayRouter);
  app.use('/api/public/catAttempts', catAttemptsRouter); // POST (submit) + GET /mine (scoped to one email)
  app.use('/api/public/referrals', referralsRoutes.publicRouter); // GET /:email — a student's own referral dashboard
  app.use('/api/public/students', studentsPublicRouter); // GET (Password stripped) + POST /login + POST /change-password

  // ---- Admin API (every route below requires a valid admin token) ----
  COLLECTIONS.forEach(function (name) {
    app.use('/api/admin/' + name, makeAdminRouter(name));
  });
  app.use('/api/admin/settings', settingsRouter);
  app.use('/api/admin/referralProgram', settingsRouter);
  app.use('/api/admin/enrollPageCopy', settingsRouter);
  app.use('/api/admin/auth', authRouter);
  app.use('/api/admin/upload', uploadRouter); // PDF uploads (PYQ papers, etc.) -- admin only
  app.use('/api/admin/bulk-import', bulkQuestionsRouter); // Excel bulk question import -- admin only
  app.use('/api/admin/referrals', referralsRoutes.adminRouter); // payouts-due / payouts / mark-paid -- admin only

  app.get('/api/health', function (req, res) { res.json({ ok: true }); });

  // ---- Serve uploaded files (PYQ PDFs, etc.) publicly so students can open them ----
  app.use('/uploads', express.static(UPLOAD_DIR));

  // ---- Serve the admin dashboard's static files ----
  app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

  // ---- Serve the main website's static files (index.html, courses.html, css/, js/, images/, etc.) ----
  // Block direct access to the backend's own folder before the static server runs.
  app.use('/admin-server', function (req, res) { res.status(404).end(); });
  app.use(express.static(path.join(__dirname, '..'), { index: 'index.html' }));

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, function () {
    console.log('MBA Partner site + admin API running on http://localhost:' + PORT);
    console.log('Admin dashboard: http://localhost:' + PORT + '/admin');
    console.log('Data file: ' + db.DB_PATH);
  });

  // ---- Free-tier keep-alive ----
  // Render's free web services spin down after ~15 minutes with no incoming
  // traffic, so the next real visitor eats a slow "cold start". Render sets
  // RENDER_EXTERNAL_URL automatically in production (it's absent locally, so
  // this is a no-op on your own machine) -- when present, ping our own
  // /api/health every 10 minutes. That's a genuine round-trip out to the
  // internet and back in through Render's proxy, which counts as real
  // traffic and resets the inactivity timer, keeping the service warm
  // without needing any third-party uptime-monitor account.
  if (process.env.RENDER_EXTERNAL_URL) {
    const https = require('https');
    setInterval(function () {
      https.get(process.env.RENDER_EXTERNAL_URL + '/api/health', function (res) { res.resume(); })
        .on('error', function () { /* ignore -- the next scheduled ping will just retry */ });
    }, 10 * 60 * 1000); // every 10 minutes (well under Render's ~15 min spin-down window)
  }
}

start().catch(function (e) {
  console.error('Failed to start server:', e);
  process.exit(1);
});
