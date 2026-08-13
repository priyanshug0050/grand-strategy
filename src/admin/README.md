# Admin module

Separable, like `src/market/`. Nothing else in the game imports from here.

## Mounting

`server.js` mounts it with two lines:

```js
const adminRoutes = require('./src/admin/routes');
app.use(adminRoutes.mount({ verifyToken: auth.verifyToken, wrap, db }));
```

Comment them out and the entire admin surface is gone.

## Becoming an admin

There is **no endpoint** that grants admin. Not a protected one, not a
"first-time setup" one. An API that can promote can be tricked into promoting.

The only way:

```sql
UPDATE users SET is_admin = TRUE WHERE email = 'you@example.com';
```

Run that against the database directly (Neon SQL Editor, or psql). To revoke,
set it back to `FALSE` — it takes effect on the very next request, because
admin status is read from the database rather than baked into a token.

## The security model

| Layer | What it does |
|---|---|
| Database check per request | Not the JWT. Revocation is instant. |
| 404 on every failure | Not 403. The panel is invisible, not merely locked. |
| Anonymous also gets 404 | A 401 would confirm the route exists. |
| No promotion endpoint | Promotion is SQL-only. |
| Mandatory reason | Enforced in the service layer, not the route. |
| Audit log in the same transaction | Log and change commit together or not at all. |
| Rate limited to 30/min | Bounds the damage if an account is ever taken. |

`tests/test-admin.js` proves each of these. If one fails, stop and fix it.

## What this cannot protect against

If someone gets your password, they are you. Use a long unique password, never
reuse it, never commit `.env`, and **do not play the game on your admin
account** — use a second account with no admin flag, so a compromise costs you
tools rather than tools plus a nation.

## The audit log

Every mutation writes to `admin_log`: who, when, what, the value before, the
value after, the reason, and a hashed IP.

Nothing in the application can edit or delete it — there is deliberately no
route for that, and a test asserts none exists. If a player ever claims the
admin cheated, this table is the answer. If your account is ever compromised,
this table is how you find out what was done.

Absolute values are recorded, never relative ones: "set money to 5,000,000" is
reproducible six months later; "added 2,000,000" depends on what the balance
happened to be at the time.
