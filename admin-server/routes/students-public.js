/* ============================================================
   PUBLIC STUDENTS ROUTER (security-scoped)
   ------------------------------------------------------------
   The generic makePublicRouter() would serve the ENTIRE students
   collection to anyone, unauthenticated — including the plaintext
   Password field. That's a real credential leak (anyone could open
   /api/public/students and read every student's password).

   This router replaces that generic mount for 'students' only:
     GET  /api/public/students             -> same list, but Password stripped
     POST /api/public/students/login       -> { email, password } -> { ok, name }
     POST /api/public/students/change-password -> { email, oldPassword, newPassword } -> { ok }

   Credential checking happens here, server-side, so the browser never
   needs (and never receives) anyone's password.
============================================================ */
const express = require('express');
const db = require('../lib/db');

const router = express.Router();

function stripPassword(s) {
  const { Password, ...rest } = s;
  return rest;
}

router.get('/', (req, res) => {
  const rows = db.getCollection('students');
  res.json(rows.map(stripPassword));
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });
  const rows = db.getCollection('students');
  const s = rows.find(x => String(x.Email || '').trim().toLowerCase() === String(email).trim().toLowerCase());
  if (!s || String(s.Password) !== String(password)) {
    return res.status(200).json({ ok: false });
  }
  res.json({ ok: true, name: s.Name || '' });
});

router.post('/change-password', (req, res) => {
  const { email, oldPassword, newPassword } = req.body || {};
  if (!email || !oldPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'Email, current password, and new password are all required.' });
  }
  if (String(newPassword).length < 8) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
  }
  const rows = db.getCollection('students');
  const idx = rows.findIndex(x => String(x.Email || '').trim().toLowerCase() === String(email).trim().toLowerCase());
  if (idx === -1 || String(rows[idx].Password) !== String(oldPassword)) {
    return res.status(400).json({ ok: false, error: 'Current password is incorrect.' });
  }
  rows[idx] = { ...rows[idx], Password: String(newPassword) };
  db.setCollection('students', rows);
  res.json({ ok: true });
});

module.exports = router;
