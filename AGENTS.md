# Repository Guidelines

## Project Structure & Module Organization
- `controller/`: Node.js Express + WebSocket server; entry `src/server.js`; static control UI in `public/`; uploaded media/state in `data/`.
- `android-client/`: Kotlin app with ExoPlayer/OkHttp; flavors `left|center|right` in `app/`; edit `app/build.gradle` for `WS_URL` and role defaults.
- `notes/`: decision log; update when protocols or deployment steps change.
- `README-hand-off.md`: rapid ops reference—refresh after notable behavior changes.

## Build, Test, and Development Commands
- Controller (local): `cd controller && npm install && npm start` (port 8080, WS `/ws`); `npm run dev` is identical. Docker: `npm install --production && docker compose up -d --build` from `controller/`.
- Android: open `android-client/` in Android Studio; or `cd android-client && ./gradlew assembleLeftDebug` (swap flavor). APKs land in `android-client/app/build/outputs/apk/<flavor>/debug/`.
- Smoke checks: `curl http://localhost:8080/api/ping`; then POST to `/api/broadcast` with a 5s-future `startAtUtcMs` to confirm devices sync.

## Coding Style & Naming Conventions
- JavaScript: ES modules, 2-space indent, semicolons, `const`/`let`; `camelCase` for code, lowercase REST paths (`/api/devices`, `/api/broadcast`). Keep WebSocket payload keys stable with the current schema.
- Kotlin/Android: `PascalCase` classes, `camelCase` members, resources `snake_case`. Role logic lives in flavor config; inject clocks/WS endpoints if you add tests.

## Testing Guidelines
- No automated suite yet—add unit tests for new server logic (Jest + supertest) and gate via `npm test`. Cover message parsing, validation, and broadcast timing.
- Manual: run `npm start`, hit `/api/ping`, then `/api/broadcast` with future `startAtUtcMs` and confirm <100ms drift on clients. For Android, inspect `adb logcat | findstr videowall` for `Connected` and `play`.

## Commit & Pull Request Guidelines
- Use short, imperative subjects; prefer Conventional Commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`). Note protocol changes in the body.
- PRs: describe scope and risks, list test evidence (commands run, devices used), and link tickets. Attach screenshots/logs for UI or WS flow changes. Branch naming: `feature/<topic>` or `fix/<issue>`.

## Security & Configuration Tips
- Controller ships without auth/HTTPS—keep deployments on LAN or behind a reverse-proxy with auth. Avoid committing real URLs or credentials; prefer env vars for future secrets.
- `data/` and `public/` mount into Docker; confirm permissions and prune media before sharing the repo.
