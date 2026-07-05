/* Public API for CAT/OMETs mock-test attempts (mock-exam.html).
   Deliberately NOT one of the generic collections in resource.js's public
   loop -- a student's attempt list must only ever be readable by that same
   student (never the full collection, which would leak every other
   student's scores), and a submission needs a server-side duplicate check
   (one attempt per student per paper) that the generic write-only router
   doesn't do. Admin read/delete access still goes through the normal
   generic /api/admin/catAttempts route (see resource.js's COLLECTIONS). */
const express = require('express');
const db = require('../lib/db');
const router = express.Router();

// Real percentile-rank against every OTHER attempt for the same paper —
// replaces the old client-side formula (mock-exam.html used to fake this as
// `50 + score*4 + random jitter`, based only on the student's own raw score,
// completely ignoring how everyone else on that paper actually did. That's
// why a 1st-rank student could still see ~50%ile: the formula never looked
// at the leaderboard at all). "otherRows" must NOT include the score being
// evaluated. Ties get half-credit (standard percentile-rank convention);
// with nobody else to compare to yet, the first attempt on a paper is given
// the benefit of the doubt at 99.9.
function computePercentile(otherRows, score) {
  const total = otherRows.length;
  if (!total) return 99.9;
  const below = otherRows.filter(r => (r.Score || 0) < score).length;
  const equal = otherRows.filter(r => (r.Score || 0) === score).length;
  return Math.round(((below + 0.5 * equal) / total) * 1000) / 10;
}

router.post('/', (req, res) => {
  const { Email, MockID, Score } = req.body || {};
  if (!Email || !MockID) return res.status(400).json({ error: 'Email and MockID are required' });
  const rows = db.getCollection('catAttempts');
  const already = rows.find(r =>
    (r.Email || '').toLowerCase() === String(Email).toLowerCase() && r.MockID === MockID
  );
  if (already) {
    // Not an error — the client (mock-exam.html) uses this to show the
    // student their already-submitted result instead of double-recording
    // a second attempt (e.g. two tabs open, or a race on submit).
    return res.status(200).json({ ok: true, alreadyAttempted: true, attempt: already });
  }
  // Server computes the real percentile itself (against every existing
  // attempt for this paper) rather than trusting whatever the client sent —
  // keeps this accurate even if an older/buggy client is still cached in
  // someone's browser.
  const others = rows.filter(r => r.MockID === MockID);
  const percentile = computePercentile(others, Number(Score) || 0);
  const record = { _id: db.nextId(rows), ...req.body, Percentile: percentile, submittedAt: new Date().toISOString() };
  rows.push(record);
  db.setCollection('catAttempts', rows);
  res.status(201).json({ ok: true, attempt: record });
});

// Percentile preview — lets the client show the correct percentile on the
// results screen immediately (before/without waiting on the POST above),
// and lets an already-submitted student's stored result be re-displayed
// with an up-to-date percentile (recomputed against however many more
// people have attempted the paper since), instead of trusting a
// possibly-stale (or, for older records, straight-up wrong/fake) stored
// value. excludeEmail leaves the caller's own already-saved row out of the
// comparison set so they aren't compared against themselves.
router.get('/percentile', (req, res) => {
  const mockId = req.query.mockId;
  const score = Number(req.query.score);
  if (!mockId || Number.isNaN(score)) return res.status(400).json({ error: 'mockId and score are required' });
  const exclude = String(req.query.excludeEmail || '').trim().toLowerCase();
  const others = db.getCollection('catAttempts').filter(r =>
    r.MockID === mockId && (!exclude || (r.Email || '').toLowerCase() !== exclude)
  );
  res.json({ percentile: computePercentile(others, score), totalAttempts: others.length });
});

// Scoped to one email (and optionally one paper) — safe to leave open
// without an admin token, unlike a plain GET of the whole collection.
router.get('/mine', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.json([]);
  const rows = db.getCollection('catAttempts');
  let mine = rows.filter(r => (r.Email || '').toLowerCase() === email);
  if (req.query.mockId) mine = mine.filter(r => r.MockID === req.query.mockId);
  res.json(mine);
});

// Real, live leaderboard for one specific paper — replaces the old demo/fake
// names shown on the results screen now that the site has real students.
// Deliberately strips Email/Phone/answers before responding (only Name,
// Score, MaxScore, Percentile go out) so this stays safe as a public,
// no-token route. excludeEmail lets the caller leave their own row out of
// the response and splice their own just-computed result back in locally,
// instead of racing the fire-and-forget POST that just saved it.
router.get('/leaderboard', (req, res) => {
  const mockId = req.query.mockId;
  if (!mockId) return res.json([]);
  const exclude = String(req.query.excludeEmail || '').trim().toLowerCase();
  const rows = db.getCollection('catAttempts').filter(r => r.MockID === mockId);
  const board = rows
    .filter(r => !exclude || (r.Email || '').toLowerCase() !== exclude)
    // Percentile is recomputed fresh here (against every other row for this
    // paper) rather than trusting whatever's stored on the row — older
    // attempts saved before this fix have a bogus stored value, and even
    // for newer ones the true percentile shifts every time someone else
    // attempts the paper, so the leaderboard should always reflect the
    // current standing rather than a snapshot from whenever each student submitted.
    .map(r => ({ Name: r.Name || 'Student', Score: r.Score || 0, MaxScore: r.MaxScore || 0, Percentile: computePercentile(rows.filter(o => o !== r), r.Score || 0) }))
    .sort((a, b) => b.Score - a.Score || b.Percentile - a.Percentile)
    .slice(0, 20);
  res.json(board);
});

module.exports = router;
