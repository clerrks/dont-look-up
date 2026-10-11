# Don't Look Up

### Play it: **[dontlookup.cc](https://dontlookup.cc/)**

A planetary-defense game where you must decide before you are sure. A real asteroid, built from live NASA and JPL data, might hit Earth. A cloud of glowing dots on a 3D globe shows every place it could land, and it only narrows as you gather data. Act too early and a false alarm wastes your budget. Act too late and no spacecraft can arrive.

- Real orbits and sizes from JPL, plus asteroids passing Earth this week and over the next decade
- Telescopes, radar, a rendezvous probe, kinetic impactors, a gravity tractor, shelters, evacuations, emergency funding and a nuclear last resort
- Dr. Okafor, an AI chief scientist, advises you in plain language, with a narrator, captions and an ambient score that rises with the danger
- A **Daily Challenge**: the same rock and the same money for everyone, a top-5 leaderboard, and a cinematic **Analyze** replay of how anyone played

## How the model works

The game is a simplified but honest simulation. Everything below is implemented in `src/sim/model.ts`.

### Where could it land? The impact plane

Close to Earth, the asteroid's path is a straight line. Its position relative to Earth is described by two numbers in the *impact plane* (the plane through Earth's centre, perpendicular to the asteroid's approach): a cross-track offset $\xi$ and an along-track offset $\zeta$, in Earth radii. The team's best estimate is a Gaussian that starts wide and narrows:

$$p(\xi,\zeta) = \mathcal{N}\!\left(\xi,\zeta \;\middle|\; \mu(t),\ \mathrm{diag}\big(\sigma_\xi(t)^2,\ \sigma_\zeta(t)^2\big)\right)$$

Gravity pulls the rock in, so Earth is a bigger target than its own radius. The effective radius is

$$b_{\mathrm{imp}} = R_\oplus \sqrt{1 + \left(\frac{v_{\mathrm{esc}}}{v_\infty}\right)^{2}}$$

with $v_{\mathrm{esc}} = 11.186\ \mathrm{km/s}$ and $v_\infty$ the asteroid's speed far from Earth.

### How the uncertainty shrinks

Observations make the picture sharper. If $T$ is the time until impact and $s(t)$ is the time since discovery plus any bonus bought with telescopes, radar or a probe, the fraction of the original uncertainty that remains is

$$f(t) = \left(1 - \frac{s(t)}{T}\right)^{p}, \qquad \sigma(t) = \sigma_{\mathrm{floor}} + \big(\sigma_0 - \sigma_{\mathrm{floor}}\big)\, f(t)$$

The exponent $p$ is chosen per scenario so that the answer becomes clear late in the round, and the starting width $\sigma_{0,\zeta}$ is solved numerically so the opening impact chance matches the briefing (for example 1 in 10).

### The chance of a hit, and the dots on the globe

The impact probability is the Gaussian's mass inside the disc of radius $b_{\mathrm{imp}}$:

$$P_{\mathrm{hit}} = \iint_{\xi^2+\zeta^2 < b_{\mathrm{imp}}^2} p(\xi,\zeta)\, d\xi\, d\zeta$$

The dots are 4,200 fixed Monte Carlo samples of that distribution, each mapped to a spot on Earth. A line arriving from sky direction $\hat R$ with sideways offset $\mathbf O$ (in Earth radii, $|\mathbf O|<1$ means a hit) meets the planet at

$$\mathbf p = \mathbf O + \hat R \sqrt{1 - |\mathbf O|^{2}}$$

Earth turns by $15.041^\circ$ per hour, so arriving $\tau$ hours early or late shifts the landing longitude by $15.041\,\tau$ degrees. The asteroid you see flying in, its path, and the dots all come from this one calculation.

### Pushing it away

A kinetic impactor of mass $m$ hitting at speed $v$ changes the asteroid's velocity by

$$\Delta v = \frac{\beta\, m\, v}{M}$$

where $M$ is the asteroid's mass and $\beta$ is the momentum enhancement from the debris it throws off (about 2 on average, unknown to the player until a probe weighs the rock or the result is measured). A speed change applied a time $t_{\mathrm{rem}}$ before impact grows into a displacement along the orbit of roughly

$$\Delta s \approx 3\,\Delta v\, t_{\mathrm{rem}}$$

which is why a tiny push years early beats a huge one late. A gravity tractor of mass $m$ hovering at distance $d$ accelerates the asteroid at $a = G m / d^{2}$ for a time $\tau$, giving

$$\Delta s \approx 3\,a\,\tau\left(t_{\mathrm{rem}} + \tfrac{\tau}{2}\right)$$

### What a hit does

Impact energy is $E = \tfrac12 M v_{\mathrm{imp}}^{2}$. With the yield $Y$ in megatons of TNT, the blast zones scale with its cube root:

$$r_{\mathrm{severe}} \approx 7.2\, Y^{1/3}\ \mathrm{km}, \qquad r_{\mathrm{damage}} \approx 19\, Y^{1/3}\ \mathrm{km}$$

The crater uses a simplified Collins-style scaling. People lost come from the 88 major cities in the game (with how much of each city lies in each zone, and how much was evacuated or sheltered), plus roughly 25 people per square kilometre on any land the zones cover.

### Scoring

$$\text{score} = \underbrace{\text{lives}}_{\le 600} + \underbrace{250\left(1 - \frac{\text{spent}}{\text{budget}}\right)}_{\text{thrift}} + \underbrace{\text{prudence}}_{\le 150} - \text{nuclear penalty}$$

Lives compare your deaths with what would have happened with no action. Thrift rewards money left over. Prudence rewards not wasting evacuations on places that were never at risk. A nuclear burst costs points when cheaper options were still open or the rock would have missed anyway.

### What is simplified

Two-body Keplerian orbits, a Gaussian posterior, linear along-track deflection, metropolitan populations, and a hypothetical impact built on the real orbit of each asteroid. Real asteroids too large to deflect are scaled down and labelled as hypothetical.

## Daily Challenge

Everyone gets the same rock, seed and a fixed $2.4B budget each UTC day, built from a bundled catalogue so no live data can change it. Scores go to a Cloudflare D1 database:

| Endpoint | What it does |
| --- | --- |
| `GET /api/daily/board?day=` | top 5 for the day, player count, today's date |
| `POST /api/daily/submit` | stores a run (best score per name per day), returns the rank |
| `GET /api/daily/run?id=` | the saved actions of one run, replayed by **Analyze** |

Scores come from the browser and are sanity-checked on the server (ranges, sum of parts, budget, action list) but not re-simulated, so the board is an honor system.

## Data and AI

| Source | Used for |
| --- | --- |
| JPL Small-Body Database and Close-Approach Data | orbits, sizes and the next close passes |
| NASA NeoWs | asteroids passing Earth this week |
| JPL Close-Approach Data | asteroids passing in the next ten years |
| Groq (`gpt-oss-120b`), then Claude, then Cloudflare Workers AI, then scripted lines | the advisor, briefings and debriefs |

Data endpoints are cached at the edge, and the client keeps fallbacks so the game works offline-ish.

## Built with

TypeScript, three.js (custom GLSL shaders), Vite, Web Audio API, Cloudflare Workers, Cloudflare D1, Workers AI, Groq, NASA and JPL APIs, Fish Audio (narrator).

## Assets

3D models (asteroids, impactor rockets, gravity tractor) come from the CraftPix space model pack and are converted at runtime from FBX. Narration was generated with Fish Audio; sound effects and ambience are royalty-free recordings.
