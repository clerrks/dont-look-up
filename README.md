# Don't Look Up

A planetary-defense game: an asteroid may hit Earth, you must decide before you are sure. 3D globe (three.js), real NASA/JPL data, a Monte Carlo risk corridor, and an AI chief scientist.

## Run locally

```bash
npm install
npm run build
npx wrangler d1 execute dontlookup-daily --local -c wrangler.dev.jsonc --file worker/schema.sql   # once: local leaderboard table
npx wrangler dev -c wrangler.dev.jsonc --port 8787   # worker + static assets + local D1, no AI binding
npm test                                              # simulation balance check
```

## Deploy (Cloudflare Workers, custom domain dontlookup.cc)

```bash
npx wrangler login
npm run deploy
```

Optional secrets (the game works without them):

```bash
npx wrangler secret put NASA_API_KEY        # free key from api.nasa.gov; default is the shared DEMO_KEY
npx wrangler secret put GROQ_API_KEY        # free key from console.groq.com; advisor/briefing/debrief via Groq (gpt-oss-120b; override with GROQ_MODEL)
npx wrangler secret put ANTHROPIC_API_KEY   # optional alternative (Claude)
```

## Daily Challenge (Cloudflare D1)

Everyone gets the same rock, seed and a fixed $2.4B budget each UTC day (`src/daily.ts`, built from the bundled catalogue so no live data can change it). Scores go to a D1 database (`dontlookup-daily`, binding `DB`, schema in `worker/schema.sql`):

| Endpoint | What it does |
| --- | --- |
| `GET /api/daily/board?day=` | top 5 for the day, player count, today's date |
| `POST /api/daily/submit` | stores a run (best score per name per day), returns the rank |
| `GET /api/daily/run?id=` | the saved actions of one run, used by Analyze to replay it sped up |

Scores are reported by the browser and sanity-checked (ranges, sum of parts, budget, action list) but not re-simulated, so the board is an honor system.

## Sound

`src/audio.ts` plays the narrator lines (`public/audio/<id>.mp3`, words in `src/data/voice.ts`, shown as captions), the sound effects and the ambience, with one speaker button. Loudness is levelled in code: narrator about -20 dB, ambience about -37 dB, effects set per sound. Long files are trimmed and faded where used (for example the rocket launch). The first visit shows a "turn your volume up" notice, because browsers only allow sound after a click.

## Data and AI

| Endpoint | Source |
| --- | --- |
| `/api/catalog`, `/api/object` | JPL Small-Body Database (orbits, size) + Close-Approach Data |
| `/api/week` | NASA NeoWs feed (falls back to JPL CAD if rate-limited) |
| `/api/upcoming` | JPL Close-Approach Data, next ten years |
| `/api/advisor`, `/briefing`, `/debrief`, `/evac` | Groq (if `GROQ_API_KEY`), else Claude (if `ANTHROPIC_API_KEY`), else Workers AI, else scripted answers |

All data endpoints are cached at the edge; the client has cached fallbacks.

## What is simplified

Two-body Keplerian orbits; a Gaussian impact-plane posterior sampled as a Monte Carlo cloud; linear along-track deflection (`3 * dv * t`); DART-style momentum enhancement (beta) unknown to the player; cube-root blast scaling; metropolitan populations. Real asteroids too large to deflect are scaled down and labelled as hypothetical.

## Assets

3D models (asteroids, impactor rockets, gravity tractor) come from the supplied `space-3d-models-pack` (CraftPix licence), converted at runtime from FBX; copies used by the game live in `public/models`. The asteroid icon (`manual/asteroid-icon.png`) is the favicon and appears in the chart and on the home screen.
