# AniStream Tracker

A lightweight, premium anime watch tracker featuring real-time progress syncing, live ticking airing countdowns, seasonal discovery, and intelligent priority-based sorting.

## Features

- **Split Dashboard Layout**:
  - **🍿 Ready to Watch**: Grouped at the top. Displays shows that have new unwatched episodes available (i.e. currently aired count > your progress).
  - **📅 Watchlist (Caught Up)**: Grouped below. Displays shows where you are fully up-to-date. This section is cleanly paginated to prevent clutter.
- **Live Ticking Airing Countdowns**: Shows with scheduled airing episodes display a live countdown badge. Timers under 24 hours tick in real-time down to the second.
- **Auto-Refresh Scheduling**: When a countdown reaches zero, the application automatically triggers a background refresh to query the new schedule from AniList and shifts the anime to "Ready to Watch".
- **Multi-Criteria Priority Sorting**: Watchlist items are dynamically organized by:
  1. Shows with unwatched episodes first (ordered by unwatched count descending).
  2. Caught-up shows with active upcoming countdowns next (ordered by soonest airing first).
  3. Caught-up finished or non-airing shows last (ordered by most recently finished/started date).
  4. Alphabetical fallback.
- **AniList Integration**: Uses the AniList GraphQL API to fetch show metadata (official covers, total episodes, release dates) and scheduling information.
- **Supabase Cloud Syncing**:
  - Features Supabase Authentication (`login.html` and standalone dashboard access).
  - Watchlists are synced in real-time with a PostgreSQL database, utilizing Row-Level Security (RLS) to keep user data secure.
  - Offline-first caching keeps metadata and local states in `localStorage` for sub-second, instant loads.

---

## Tech Stack

- **Core**: HTML5, Vanilla JavaScript (ES6)
- **Styling**: Tailwind CSS
- **APIs**: AniList GraphQL API
- **Backend / DB**: Supabase Auth & PostgreSQL

---

## Configuration

To sync your watch list with the cloud, create a `config.json` file in the root directory:

```json
{
  "supabaseUrl": "https://your-project-id.supabase.co",
  "supabasePublishableKey": "your-anon-publishable-key"
}
```

If `config.json` is missing or keys are not provided, the tracker automatically falls back to **Local-Only mode** using your browser's local storage.

---

## How to Run

Since the application is built as a static client-side web app:
1. Simply host the files on any static HTTP server (e.g. `npx http-server`, Live Server extension, or Python's `python -m http.server`).
2. Alternatively, you can open `index.html` directly in your browser.
