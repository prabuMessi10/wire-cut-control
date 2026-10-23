# Wire Cut Control

A full-stack **MERN** application for an automated wire-cutting system that
talks to an **ESP32** controller over local WiFi. Operators submit cut jobs
from a browser dashboard; the Express backend relays each job to the ESP32
(`POST /cut`, then polls `/status`), records every result in MongoDB, and shows
live history on screen. The UI is a faithful React port of the reference
`wire-cut-control.html` design (draggable ruler length control, step-progress
indicator, status cards, settings drawer, job-history tables).

---

## Architecture

```
┌──────────────┐   HTTP (same origin)    ┌──────────────┐   HTTP    ┌──────────────┐
│  React (Vite)│ ──────────────────────► │ Express API  │ ────────► │ ESP32        │
│  /client     │   /api/* (proxied in dev)│  /server     │  /cut,    │  controller  │
│  JWT in      │ ◄────────────────────── │  + Mongoose  │  /status  │  (WiFi)      │
│  httpOnly    │       JSON responses    │  + MongoDB   │ ◄──────── │              │
│  cookie      │                         └──────┬───────┘            └──────────────┘
└──────────────┘                                │
                                          MongoDB (jobs,
                                          users, settings)
```

**Why relay through the backend?** The browser never hits the ESP32 directly.
This avoids CORS problems entirely, keeps a single server-side source of truth,
and lets every job (who, what, when, ESP32 response, success/error) be logged
to MongoDB automatically.

---

## Tech stack

| Layer    | Technology                                              |
| -------- | ------------------------------------------------------- |
| Client   | React 18, Vite 5, React Router 6, plain CSS design system |
| Server   | Node.js 18+, Express 4, Mongoose 8, JWT + bcryptjs      |
| Database | MongoDB (local `mongod`) — or a zero-install **in-memory MongoDB** dev fallback |
| Device   | ESP32 (Arduino) exposing `POST /cut` and `GET /status`  |

> Passwords are hashed with bcrypt (10 salt rounds, via the pure-JS
> `bcryptjs` implementation so no native build is needed on Windows). The JWT
> is stored in an **httpOnly cookie**, never in `localStorage`.

---

## Prerequisites

- **Node.js ≥ 18** (tested on v24) — global `fetch` is used server-side.
- **MongoDB** (optional for local dev) — either install MongoDB Community
  Server, point `MONGO_URI` at any MongoDB (local/Atlas), **or** run the app
  with `MONGODB_MEMORY=true` and skip MongoDB entirely (see below).

---

## Setup

### 1. Install dependencies

From the project root:

```bash
npm run install:all
```

(or `npm install` separately in `server/` and `client/`.)

### 2. Configure environment variables

Each app reads its own `.env`:

```bash
# server
copy server/.env.example  server/.env   # Windows
# or
cp server/.env.example server/.env      # macOS / Linux
```

```bash
# client (optional - unset it and the Vite proxy is used instead)
copy client/.env.example  client/.env
```

Key variables (`server/.env`):

| Variable          | Purpose                                        | Example                          |
| ----------------- | ---------------------------------------------- | -------------------------------- |
| `MONGO_URI`       | MongoDB connection string                      | `mongodb://127.0.0.1:27017/wire_cut_control` |
| `MONGODB_MEMORY`  | `true` = boot an in-memory MongoDB (no install; data lost on restart) | `false` |
| `MONGOD_BIN`      | Optional: explicit path to a `mongod` binary for memory mode | `C:\…\mongod.exe` |
| `JWT_SECRET`      | Signing secret for auth tokens                 | any long random string           |
| `JWT_EXPIRES_IN`  | Token lifetime                                 | `12h`                            |
| `PORT`            | API port                                       | `5000`                           |
| `ESP32_IP`        | Default controller IP (editable in the UI)     | `192.168.1.42`                   |
| `CLIENT_ORIGIN`   | Allowed CORS origin(s), comma separated        | `http://localhost:5173`          |
| `ADMIN_EMAIL`/`ADMIN_PASSWORD` | Bootstrap admin for the seed script |                 |

### 2b. Quick start — no MongoDB installed 🚀

Don't want to install MongoDB? The server can run a throwaway **in-memory
MongoDB** automatically. In `server/.env` set:

```dotenv
MONGODB_MEMORY=true
```

Then just:

```bash
npm run dev        # web :5173, API :5000 — nothing else needed
```

Details:

- An in-memory `mongod` is started by the API process on boot and shut down
  with it; **all data is lost on restart** (fine for demos/tests).
- The admin account is **auto-created at server start** from
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` (no `npm run seed` needed in this mode — the
  seed script prints this hint itself).
- First boot looks for an already-downloaded `mongod` binary (env `MONGOD_BIN`,
  or the mongodb-memory-server cache under your home dir); if none is found it
  downloads one (~600 MB, cached afterwards). Docs hardware later — just switch
  back to `MONGODB_MEMORY=false` with a real `MONGO_URI`.

### 3. Seed the admin account

Creates the first admin (only if no admin exists yet) using
`ADMIN_EMAIL` / `ADMIN_PASSWORD` from `server/.env`:

```bash
npm run seed
```

> In memory mode (`MONGODB_MEMORY=true`) a separate seed process cannot share
> the API's in-memory database, so the script just prints a hint — the admin is
> created automatically when the server boots instead.

Default dev admin (as shipped in `server/.env`):

```
email:    admin@wirecut.local
password: AdminPass123!
```

> ⚠️ Change `JWT_SECRET` and the admin password before any real deployment.

### 4. Start development servers

```bash
npm run dev
```

- Web app: **http://localhost:5173** (Vite proxies `/api` → `:5000`)
- API: **http://localhost:5000/api/health**

Or run them in separate terminals: `npm run dev --prefix server` and
`npm run dev --prefix client`.

### 5. Build for production

```bash
npm run build        # builds client/ into static assets
npm run start:server # serves the API on :5000
```

---

## Using the app

1. **Sign up** as a new operator (name, email, password) → the account is
   created with status `pending` and **cannot log in yet**. Logging in shows
   *"Your account is awaiting admin approval."*
2. **Admin** signs in (see seeded credentials above) → **Pending requests**
   card shows new signups; approve or reject each one. Admins can also
   **create employees directly** (skip the request flow) and **delete
   employees** (with confirmation; job history is removed too).
3. **Employee** signs in → **New Cut Job** card:
   - drag the tape-measure **ruler** (or type a value, toggle mm/cm/in)
   - pick quantity, wire gauge, and a job reference
   - hit **Send cut job** — the job goes to the backend, which relays it to the
     ESP32 and waits for the cycle; the step indicator animates
     Idle → Feeding → Cutting → Done.
4. The **Live Status** card, **Request payload** card and **Device** card give
   a live view of the machine. The **Settings drawer** (gear icon) toggles
   **demo mode**, sets the ESP32 IP and the maximum wire length.
5. **Admin → Job history** filters by employee, date range and status.

---

## ESP32 integration

The backend talks to the ESP32 over plain HTTP JSON:

| Endpoint                   | Direction | Payload                                                        |
| -------------------------- | --------- | -------------------------------------------------------------- |
| `POST http://<ip>/cut`     | → device  | `{ length_mm, qty, gauge, ref }` → expects `{ status: "started" }` |
| `GET  http://<ip>/status`  | ← device  | `{ state: "idle"\|"feeding"\|"cutting"\|"done"\|"error" }`     |

- The send is a one-shot `POST /cut`; the backend then **polls `/status` every
  300 ms** until `done` or `error`. The poll deadline is **derived from the job
  size** (`qty × (900 ms + length_mm × 1.2 ms + 500 ms)`, ×1.3 safety), clamped
  to a 60 s floor and a 10-minute ceiling — a large batch is never falsely
  failed by a short fixed timeout. The browser uses the same model when timing
  its own request.
- In **demo mode** (default) the backend simulates the same sequence so the
  full stack works with zero hardware. The simulated cycle scales with job
  size but is capped at 45 s to stay snappy.

Example ESP32 sketch outline:

```cpp
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void handleCut() {
  // parse JSON body, run the feed/cut cycle, respond
  server.send(200, "application/json",
              "{\"status\":\"started\",\"length_mm\":" + String(len) + "}");
  // when finished: state = "done"
}

void handleStatus() {
  server.send(200, "application/json",
              "{\"state\":\"" + String(machineState) + "\"}");
}

void setup() {
  WiFi.begin(ssid, pass);
  server.on("/cut", HTTP_POST, handleCut);
  server.on("/status", HTTP_GET, handleStatus);
  server.begin();
}
```

---

## API reference

All routes return `{ success, data }` or `{ success: false, error: { code, message } }`.
Auth uses an httpOnly cookie (`token`); protected routes fall back to an
`Authorization: Bearer <jwt>` header. Role guards are enforced **server-side**.

| Method | Endpoint                | Role     | Description                                        |
| ------ | ----------------------- | -------- | -------------------------------------------------- |
| POST   | `/api/auth/register`    | public   | Employee self-registration → `pending`              |
| POST   | `/api/auth/login`       | public   | Login (blocks `pending`/`rejected`) → sets cookie  |
| POST   | `/api/auth/logout`      | public   | Clears the auth cookie                              |
| GET    | `/api/auth/me`          | any      | Current user (session restore)                      |
| GET    | `/api/users/pending`    | admin    | Pending registration requests                       |
| POST   | `/api/users/:id/approve`| admin    | Approve a pending employee                          |
| POST   | `/api/users/:id/reject` | admin    | Reject a pending employee                           |
| POST   | `/api/users`            | admin    | Create an employee directly (approved)              |
| GET    | `/api/users`            | admin    | List all employees (status, last login)             |
| DELETE | `/api/users/:id`        | admin    | Remove an employee + their job history              |
| POST   | `/api/jobs`             | employee | Submit a cut job (relayed to ESP32, logged to DB)   |
| GET    | `/api/jobs/mine`        | employee | Personal job history                                |
| GET    | `/api/jobs/all`         | admin    | Full history; filters: `employeeId`, `from`, `to`, `status` |
| GET    | `/api/settings`         | any      | Machine settings (demo mode, ESP32 IP, max length)  |
| PUT    | `/api/settings`         | any      | Update machine settings                             |
| GET    | `/api/esp32/status`     | any      | ESP32 connection + machine state                    |

---

## Data model

**User** — `name`, `email` (unique), `passwordHash`, `role`
(`admin`/`employee`), `status` (`pending`/`approved`/`rejected`), `approvedBy`,
`approvedAt`, `lastLoginAt`, `createdAt`.

**CutJob** — `requestedBy` (ref User), `lengthMm`, `qty`, `gauge`, `ref`,
`status` (`done`/`error`), `esp32Response` (JSON), `createdAt`.

**AppSetting** — key/value store for runtime-configurable machine settings.

---

## Project structure

```
├── client/                     # React (Vite) frontend
│   ├── index.html
│   ├── vite.config.js          # /api proxy -> :5000
│   └── src/
│       ├── pages/              # Login, Signup, Employee, Admin dashboards
│       ├── components/         # RulerControl, StepIndicator, TopBar, Drawer, ...
│       ├── context/AuthContext.jsx
│       ├── api/client.js
│       └── styles/app.css      # design tokens + full design system
├── server/                     # Express + Mongoose API
│   ├── seed/createAdmin.js     # bootstrap admin (npm run seed)
│   └── src/
│       ├── models/             # User, CutJob, AppSetting
│       ├── middleware/         # auth (JWT), validation, error handler
│       ├── controllers/
│       ├── services/           # esp32 relay + settings
│       └── routes/
└── README.md
```

---

## Troubleshooting

- **`[db] ... failed` / server exits** — MongoDB is not reachable. Start
  `mongod` (or Docker `mongo:7`), change `MONGO_URI` in `server/.env`, or set
  `MONGODB_MEMORY=true` to run without MongoDB at all.
- **Memory mode: admin not created?** With `MONGODB_MEMORY=true` the admin is
  bootstrapped automatically when the server starts (a separate `npm run seed`
  can't share an in-memory DB). Check the `[bootstrap]` log line.
- **Login says "awaiting admin approval"** — the account is `pending`; approve
  it from the admin dashboard.
- **Demo mode always on?** Open the Settings drawer (gear icon) and toggle
  **Demo mode** off, then set the ESP32 IP.
- **Vite showing API errors** — confirm the API is on `:5000`; the dev proxy
  forwards `/api` there automatically.