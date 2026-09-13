# PharmAlala Backend

Minimal Node + Express + Mongoose API for the PharmAlala app.

Quick start

1. Copy `.env.example` to `.env` and fill `MONGO_URI` and `JWT_SECRET`.
2. Install dependencies:

```bash
cd backend
npm install
```

3. Run in development:

```bash
npm run dev
```

API endpoints

- `POST /api/auth/register` { name, email, password }
- `POST /api/auth/login` { email, password }
- `GET /api/medicines` (auth)
- `POST /api/medicines` (auth)
- `GET /api/reminders` (auth)
- `POST /api/reminders` (auth)

