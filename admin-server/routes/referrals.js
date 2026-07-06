/* ============================================================
   REFERRAL SYSTEM — server-side (replaces the old localStorage-only
   version that lived entirely in the browser). See REFERRAL-SYSTEM-SPEC.md
   in the project root for the full design this implements.

   - A student's referral code is generated once and stored on their
     Students row (see resource.js's autoProvisionStudent / ensureReferralCode
     below) — never in localStorage, so it works from any device.
   - Referrals collection: one row per successful "friend used my code"
     order. Status moves pending -> confirmed (after settings.referralConfirmDays,
     to cover refund/chargeback windows) -> paid (admin marks it after
     transferring the money manually at month end).
   - Payouts collection: one row per admin payout batch, for a paper trail.
   - The referral bonus amount / discount percentages all come from the
     'settings' singleton (admin-editable — see admin-config.js's
     "Referral Program" section) instead of being hardcoded.
============================================================ */
const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

function generateCode(nameOrEmail) {
  const n = String(nameOrEmail || '').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 3) || 'MBA';
  const h = Math.floor(1000 + Math.random() * 9000);
  return n + h;
}

// Ensures the given student has a referralCode, generating + persisting one
// if missing (covers students who signed up before this feature existed).
// Returns null if no student row matches this email at all.
function ensureReferralCode(email) {
  const students = db.getCollection('students');
  const idx = students.findIndex(s => (s.Email || '').toLowerCase() === String(email || '').toLowerCase());
  if (idx === -1) return null;
  if (!students[idx].referralCode) {
    let code = generateCode(students[idx].Name || students[idx].Email);
    // Vanishingly unlikely, but guard against a collision with an existing code.
    while (students.some(s => s.referralCode === code)) code = generateCode(students[idx].Name || students[idx].Email);
    students[idx].referralCode = code;
    db.setCollection('students', students);
  }
  return students[idx].referralCode;
}

// Looks up which student (if any) owns a given referral code.
function findStudentByReferralCode(code) {
  if (!code) return null;
  const students = db.getCollection('students');
  return students.find(s => (s.referralCode || '').toUpperCase() === String(code).toUpperCase()) || null;
}

// Pending -> confirmed once settings.referralConfirmDays has passed since
// the referred friend's order (covers refund/chargeback windows). Mutates
// the rows in place and returns true if anything changed (so the caller
// knows whether to persist).
function promoteStatuses(rows, settings) {
  const days = Number(settings.referralConfirmDays) || 7;
  const cutoffMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;
  rows.forEach(r => {
    if (r.status === 'pending' && r.createdAt && (now - new Date(r.createdAt).getTime()) >= cutoffMs) {
      r.status = 'confirmed';
      r.confirmedAt = new Date().toISOString();
      changed = true;
    }
  });
  return changed;
}

// Called from resource.js's autoProvisionFromSubmission whenever a new
// 'orders' row is written (both the real-payment Razorpay path and the
// 100%-off-coupon free path funnel through that same collection). If the
// order's Coupon field is actually a student's referral code (not an admin
// coupon like GROUP20/MBA10), credit the referrer.
function creditReferralIfApplicable(orderRecord) {
  const code = String(orderRecord.Coupon || '').trim();
  if (!code) return;
  const referrer = findStudentByReferralCode(code);
  if (!referrer) return; // not a referral code — nothing to credit (admin coupons fall through here harmlessly)
  if ((referrer.Email || '').toLowerCase() === (orderRecord.Email || '').toLowerCase()) return; // no crediting yourself
  const referrals = db.getCollection('referrals');
  // Guard against double-crediting the same order (e.g. a retried request).
  if (referrals.some(r => r.orderId === orderRecord._id)) return;
  const settings = db.getSingleton('settings');
  const bonus = Number(settings.referralBonusAmount) || 750;
  referrals.push({
    _id: db.nextId(referrals),
    referrerEmail: referrer.Email,
    referredEmail: orderRecord.Email || '',
    referredName: orderRecord.Name || '',
    orderId: orderRecord._id,
    courseTitle: orderRecord.Items || '',
    bonusAmount: bonus,
    status: 'pending',
    createdAt: new Date().toISOString(),
    confirmedAt: '',
    paidAt: '',
    payoutBatchId: ''
  });
  db.setCollection('referrals', referrals);
}

/* ---------------- PUBLIC: a student's own referral dashboard ---------------- */
const publicRouter = express.Router();

publicRouter.get('/:email', (req, res) => {
  const email = String(req.params.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  const code = ensureReferralCode(email);
  if (!code) return res.status(404).json({ error: 'No enrollment found for this email. Please enroll first.' });

  const settings = db.getSingleton('settings');
  const all = db.getCollection('referrals');
  const mine = all.filter(r => (r.referrerEmail || '').toLowerCase() === email.toLowerCase());
  if (promoteStatuses(mine, settings)) {
    // mine holds references into `all`'s objects (filter doesn't clone), so
    // mutations from promoteStatuses are already reflected in `all` — just persist.
    db.setCollection('referrals', all);
  }

  const totalEarned = mine.filter(r => r.status === 'confirmed' || r.status === 'paid').reduce((s, r) => s + Number(r.bonusAmount || 0), 0);
  const pending = mine.filter(r => r.status === 'pending').reduce((s, r) => s + Number(r.bonusAmount || 0), 0);
  const paidOut = mine.filter(r => r.status === 'paid').reduce((s, r) => s + Number(r.bonusAmount || 0), 0);

  res.json({
    referralCode: code,
    totalReferrals: mine.length,
    totalEarned, pending, paidOut,
    history: mine
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(r => ({ friend: r.referredName || r.referredEmail, course: r.courseTitle, status: r.status, bonus: r.bonusAmount }))
  });
});

/* ---------------- ADMIN: monthly payouts ---------------- */
const adminRouter = express.Router();
adminRouter.use(requireAuth);

// One row per referrer with a confirmed-but-unpaid balance — this is the
// admin's "who do I pay, and how much" list at month end.
adminRouter.get('/payouts-due', (req, res) => {
  const settings = db.getSingleton('settings');
  const rows = db.getCollection('referrals');
  if (promoteStatuses(rows, settings)) db.setCollection('referrals', rows);

  const students = db.getCollection('students');
  const byStudent = {};
  rows.filter(r => r.status === 'confirmed').forEach(r => {
    if (!byStudent[r.referrerEmail]) {
      const student = students.find(s => (s.Email || '').toLowerCase() === (r.referrerEmail || '').toLowerCase());
      byStudent[r.referrerEmail] = {
        studentEmail: r.referrerEmail,
        studentName: (student && student.Name) || '',
        referralCode: (student && student.referralCode) || '',
        total: 0, count: 0, referralIds: []
      };
    }
    byStudent[r.referrerEmail].total += Number(r.bonusAmount || 0);
    byStudent[r.referrerEmail].count += 1;
    byStudent[r.referrerEmail].referralIds.push(r._id);
  });
  res.json(Object.values(byStudent).sort((a, b) => b.total - a.total));
});

// Every past payout, most recent first — a simple paper trail.
adminRouter.get('/payouts', (req, res) => {
  const payouts = db.getCollection('payouts');
  res.json(payouts.slice().sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt)));
});

// Admin has transferred the money manually (bank/UPI, outside this system) —
// this just records that it happened and flips the covered rows to 'paid'.
adminRouter.post('/mark-paid', (req, res) => {
  const { studentEmail, referralIds, note } = req.body || {};
  if (!studentEmail || !Array.isArray(referralIds) || !referralIds.length) {
    return res.status(400).json({ error: 'studentEmail and referralIds are required' });
  }
  const rows = db.getCollection('referrals');
  const now = new Date().toISOString();
  const payouts = db.getCollection('payouts');
  const payoutId = db.nextId(payouts);
  let total = 0;
  rows.forEach(r => {
    if (referralIds.includes(r._id) && r.referrerEmail === studentEmail && r.status === 'confirmed') {
      r.status = 'paid';
      r.paidAt = now;
      r.payoutBatchId = payoutId;
      total += Number(r.bonusAmount || 0);
    }
  });
  if (!total) return res.status(400).json({ error: 'None of those referrals are confirmed and unpaid for this student.' });
  db.setCollection('referrals', rows);
  payouts.push({
    _id: payoutId, studentEmail, amount: total, referralIds,
    paidAt: now, paidBy: (req.admin && req.admin.username) || 'admin', note: note || ''
  });
  db.setCollection('payouts', payouts);
  res.json({ ok: true, amount: total, payoutId });
});

module.exports = { publicRouter, adminRouter, ensureReferralCode, findStudentByReferralCode, creditReferralIfApplicable };
