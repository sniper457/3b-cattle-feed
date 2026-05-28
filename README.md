# 3B Cattle · Feed Schedule

Mobile-first cattle feeding schedule app. Feeders view daily pen assignments and confirm feedings. Admin manages pen configuration and views completion logs.

## Stack
- React + Vite (frontend)
- Supabase (database + realtime)
- Vercel (hosting)

## Local development

```bash
npm install
npm run dev
```

## Deploy

Push to GitHub, connect repo to Vercel — it auto-deploys.

## Project structure

```
3b-cattle/
├── index.html
├── vite.config.js
├── vercel.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx
    └── App.jsx        ← all app logic and UI
```
