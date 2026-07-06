# Referral System — How It Should Work

**Status: SPEC — replaces the current localStorage-only implementation.**

This corrects two things in the current build: (1) referral codes/earnings live only in
the browser and never reach the server or the admin, and (2) `ENROLLMENT-FLOW.md`
incorrectly states a 30% group discount — the real number is **20%** for "enroll with a
friend," separate from the 10% one-time discount a referral *code* gives.

---

## The two discount mechanisms (don't confuse them)

| Mechanism | Who gets it | Discount | Triggers a payout? |
|---|---|---|---|
| **Enroll with a Friend** (joint checkout, both pick a course together) | Both of you, on your own course | 20% off each person's price (admin-editable) | No — this is a joint-signup promo, not a referral |
| **Referral Code** (one person already enrolled, shares their code with a friend who enrolls separately, later) | The new student (friend) | 10% off their order (admin-editable) | Yes — ₹750 credited to the referrer (amount admin-editable) |

Both stay as they are in the UI today (two tabs: Solo / Enroll with a Friend). Only the
referral-code path needs the backend rework below. None of the numbers above are
hardcoded — see **Admin-configurable settings** below.

---

## Admin-configurable settings

The site already has exactly this pattern for other numbers (homepage stats, social
links) via a `settings` singleton — `admin-server/routes/settings.js`
(`GET/PUT /api/settings`) and `js/site-settings.js` on the frontend, which fetches it on
page load and fills in whatever the admin set, falling back to the value already in the
HTML if the API is unreachable. The referral system reuses this exact mechanism instead
of inventing a new one:

| New setting key | Meaning | Today's hardcoded value |
|---|---|---|
| `referralBonusAmount` | ₹ credited to referrer per successful referral | 750 |
| `referralDiscountPercent` | % off the referred friend's order | 10 |
| `friendEnrollDiscountPercent` | % off each person in the "Enroll with a Friend" joint checkout | 20 |
| `referralConfirmDays` | days after a referred order before it auto-moves `pending` → `confirmed` | 7 (suggested) |

These get added to the same `settings` object as `heroRating`, `studentsMentored`, etc.
— one new card in the admin dashboard ("Referral Program") with four number fields, no
new backend plumbing beyond adding these keys. `enroll.html`'s checkout math
(`applyCoupon`, `updateFriendCalculation`, the referral-confirmation job) reads these
from the already-fetched settings object instead of the hardcoded `0.20`, `0.10`, `750`
currently baked into the JS — so changing the bonus or either discount is a dashboard
edit, not a code deploy.

---

## Data model (new, server-side)

**`Students`** (already exists) — add a `referralCode` field, generated once at
first successful enrollment, unique per student, stored server-side (not localStorage).

**`Referrals`** (new collection)
| Field | Meaning |
|---|---|
| `referrerEmail` | student who owns the code |
| `referredEmail` | the friend who used it |
| `referredOrderId` | the order the code was applied to |
| `courseTitle` | what the friend enrolled in |
| `bonusAmount` | 750 (fixed) |
| `status` | `pending` → `confirmed` → `paid` |
| `createdAt` | when the friend's order completed |
| `confirmedAt` | when status flipped to confirmed |
| `paidAt` | when admin marked it paid |
| `payoutBatchId` | links to the monthly payout record it was cleared in |

**`Payouts`** (new collection, one row per admin transfer)
| Field | Meaning |
|---|---|
| `studentEmail` | who got paid |
| `amount` | total transferred |
| `referralIds` | which `Referrals` rows this cleared |
| `paidAt` | date of bank transfer |
| `paidBy` | admin who did it |
| `note` | optional, e.g. UPI ref number |

---

## Step-by-step flow

**1. Student A enrolls (solo or friend flow).**
Backend generates `referralCode` for A the first time A appears in `Students`, and
returns it in the success response — same as today's UI shows it, just sourced from the
server instead of `generateRefCode()` running in the browser.

**2. Student A shares their code** with Student B (WhatsApp, in person, whatever).

**3. Student B checks out and enters A's code** in the coupon field.
`applyCoupon()` calls the existing `/api/public/coupons/validate`-style endpoint, which now
also checks the `Students.referralCode` index (not just the admin `coupons` collection and
not just the current browser's localStorage, which is the current bug). If found:
10% off B's order, and the code is tagged onto the order payload as `referralCodeUsed`.

**4. B's payment completes.**
On order confirmation (same place `enrollmentRequests`/`orders` already get written),
the backend:
- looks up which student owns `referralCodeUsed`
- writes a new `Referrals` row: `referrerEmail: A`, `referredEmail: B`, `status: pending`,
  `bonusAmount: 750`

**5. Status moves from `pending` → `confirmed`.**
Pending exists to cover refund/chargeback windows. Once your refund policy's window
passes (e.g. 7 days) with no refund on B's order, a small scheduled job (or the admin
clicking "confirm" manually if you'd rather not automate it yet) flips the row to
`confirmed`. Only `confirmed` rows count toward what's owed.

**6. Student A's dashboard** ("My Referral Dashboard" — now reads from the server by
`referrerEmail`, not `localStorage`, so it works from any device):
- **Total Referrals** — count of all rows for A
- **Total Earned** — sum of `bonusAmount` where `status` is `confirmed` or `paid`
- **Pending** — sum where `status = pending`
- Table: Friend / Course / Status / Bonus — one row per referral, exactly like the UI
  already has, just backed by real data

**7. End of month — Admin view** (new section in the admin dashboard):
A table, one row per student who has any `confirmed` (unpaid) referral balance:
`Student | Confirmed unpaid total | # referrals in that total | [Mark as Paid]`

Admin transfers the money manually via their own bank/UPI (this stays a manual, offline
step — the system never moves money itself). After transferring, admin clicks **Mark as
Paid**, which:
- creates one `Payouts` row with the total and today's date
- flips every `Referrals` row included from `confirmed` → `paid`
- the student's dashboard then shows that amount under a "Paid out" total instead of
  "Total Earned," so it's clear it's already bee
