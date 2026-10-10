# Asteroid Defense (beta)

A planetary-defense game: an asteroid may hit Earth, you must decide before you are sure. 3D globe (three.js), real NASA/JPL data, a Monte Carlo risk corridor, and an AI chief scientist.

## Run locally

```bash
npm install
npm run build
npx wrangler dev -c wrangler.dev.jsonc --port 8787   # worker + static assets, no AI binding
npm test                                              # simulation balance check
```

## Deploy (Cloudflare Workers, custom domain ad.chiefkeef.org)

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
