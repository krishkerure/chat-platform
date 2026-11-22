# Gather — scalable real-time chat

A full-stack starter for a real-time MERN chat app. The screenshot brief is represented in this starter with authenticated chat, live messages, delivery/read receipts, five emoji reactions, Redis-backed Socket.IO fan-out, a shared 30-request-per-minute API limit, and cursor pagination capped at 20 messages per page.

## Start locally

Requirements: Node.js 20+, npm, and Docker Desktop (or local MongoDB and Redis services).

1. Copy `.env.example` to `.env` and replace `JWT_SECRET` with a long random value.
2. Start the local data services: `docker compose up -d`.
3. Install the runner and each app's packages: `npm install`, `npm --prefix server install`, and `npm --prefix client install`.
4. Start both apps: `npm run dev`.
5. Open [http://localhost:5173](http://localhost:5173). The API runs on port 4000.

When `REDIS_URL` is unset, the API rate limiter uses process memory. Socket.IO also runs without the Redis adapter, but cross-instance fan-out requires a reachable Redis service. For multi-instance production deployments, configure MongoDB and Redis as managed services, set `CLIENT_ORIGIN`, `MONGODB_URI`, `REDIS_URL`, and a strong `JWT_SECRET`, and put the API behind HTTPS.

## Project map

- `server/src/index.js` — REST API, Socket.IO events, rate limit, Redis adapter, and startup.
- `server/src/models.js` — the three MongoDB collections: users, conversations, and messages.
- `server/src/auth.js` — JWT helpers and REST authentication middleware.
- `client/src/App.jsx` — React screens and chat interactions.
- `client/src/styles.css` — responsive visual styling.
- `docker-compose.yml` — local MongoDB and Redis services with persistent volumes.

## Main events

- Client to server: `conversation:join`, `message:send`, `message:delivered`, `message:read`, `reaction:toggle`.
- Server to client: `message:new`, `receipt:update`, `reaction:update`, `presence:update`.
- REST: `/api/auth/register`, `/api/auth/login`, `/api/users`, `/api/conversations`, and `/api/conversations/:id/messages?before=<messageId>`.

Messages are stored before a successful send acknowledgement. Opening a conversation records delivery; viewing it records read status. A message page returns at most 20 items and provides the oldest item as the next cursor.
