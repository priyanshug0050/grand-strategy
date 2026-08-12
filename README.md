# Grand Strategy

Multiplayer nation-simulation browser game (PBBG), built on Politics & War mechanics.

## Layout

    server.js          HTTP entry point — `npm start`
    src/
      engine/          Pure game math. No database, no I/O, no side effects.
      data/            Postgres connection and row <-> engine translation.
      api/             Auth and transactional game actions.
      scheduler.js     The turn clock.
    db/                Schema and setup script.
    tests/             One suite per module.
    public/            Frontend — served by the same server.

## The rule that keeps this maintainable

`src/engine/` never imports from `src/data/` or `src/api/`.

The engine is pure functions: numbers in, numbers out. That is why it can be
tested without a database, why battles can be replayed from a stored seed, and
why the transaction that saves a turn holds its lock for microseconds instead
of milliseconds.

If you ever find a `require('../data/db')` inside `src/engine/`, something has
gone wrong — move the query out to the service layer instead.

## Setup

    npm install
    cp .env.example .env        # then fill in JWT_SECRET and DATABASE_URL
    createdb gamedb
    psql -U gameuser -d gamedb -f db/schema.sql
    npm test
    npm start

Then open <http://localhost:3000> in a browser. That is the whole game.

## No CORS, on purpose

The server serves the frontend AND the API from the same origin, so there is
no cross-origin request and CORS never applies. Leave `CORS_ORIGIN` unset.

Do **not** open the HTML files with a separate static server (VS Code Live
Server on :5500). That reintroduces the cross-origin problem — and the
`localhost` vs `127.0.0.1` mismatch that comes with it — for no benefit.

Generate a JWT secret with:

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

## Tests

    npm test                    # everything
    node tests/run-all.js --engine-only   # no database required

## Gotchas

- Open `http://localhost:3000`, not the HTML files directly. `file://` pages
  cannot call the API.
- `RESET_DB=true` wipes every table on boot. Set it back to false immediately.
- Never commit `.env`.
