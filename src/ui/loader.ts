import { audio } from '../audio';
import { loadAllModels } from '../view/models';

const TIPS = [
  'Every line on the chart is a path the asteroid could still take. Red lines hit Earth.',
  'Buy telescope time first. It shows the real path sooner and costs far less than a spacecraft.',
  'The earlier you push, the smaller the push has to be.',
  'The yellow flag on the timeline is the last day a new spacecraft can still arrive in time.',
  'A rendezvous probe weighs the rock, so you know exactly how hard an impactor will push.',
  'Do not launch at the first scare. A false alarm wastes money and costs you points.',
  'If an impactor hits while your gravity tractor is hovering there, the debris destroys it.',
  'Radar only works once the asteroid is close, but it sharpens the picture fast.',
  'The government pays more once the danger is real. Ask for money when your budget runs low.',
  'Shelters work late and save up to 4 in 10 people. Evacuations save more, but need a year.',
  'A nuclear burst breaks the asteroid into pieces. It is a last resort, and it costs you points.',
  'Hover over the asteroid or a spacecraft, then click it to see what it is and what it cost.',
  'Press the globe button to turn the view to where the asteroid could land.',
  'The Daily Challenge is the same rock and the same money for everyone. Press Analyze on any score to watch how it was played.',
];

/** A full-screen loading screen: the game does not start until every sound and 3D model is ready. */
export async function runLoader(): Promise<void> {
  // the logo comes first, so it is already there when the loading screen appears
  await new Promise<void>((res) => { const img = new Image(); img.onload = img.onerror = () => res(); img.src = '/asteroid-icon.png'; if (img.complete) res(); });
  const root = document.createElement('div');
  root.id = 'loader';
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <div class="ld-in">
      <img src="/asteroid-icon.png" alt="" width="64" height="64" />
      <h1>Don't Look Up</h1>
      <div class="ld-bar" aria-hidden="true"><i></i></div>
      <p class="ld-msg">Loading sounds and 3D models</p>
      <p class="ld-tip" aria-live="off"></p>
    </div>`;
  document.body.appendChild(root);
  const bar = root.querySelector<HTMLElement>('.ld-bar i')!;
  const msg = root.querySelector<HTMLElement>('.ld-msg')!;
  const tipEl = root.querySelector<HTMLElement>('.ld-tip')!;
  let tipAt = Math.floor(Math.random() * TIPS.length);
  const showTip = () => {
    tipEl.classList.remove('in');
    window.setTimeout(() => { tipEl.textContent = TIPS[tipAt++ % TIPS.length]; tipEl.classList.add('in'); }, 250);
  };
  showTip();
  const tipTimer = window.setInterval(showTip, 3800);

  let modelsDone = 0, soundsDone = 0, modelsTotal = 11, soundsTotal = 80;
  const paint = () => {
    const pct = (modelsDone + soundsDone) / (modelsTotal + soundsTotal);
    bar.style.transform = `scaleX(${Math.max(0.03, Math.min(1, pct))})`;
    msg.textContent = soundsDone < soundsTotal ? `Loading sounds ${Math.round((soundsDone / soundsTotal) * 100)}%` : modelsDone < modelsTotal ? 'Loading 3D models' : 'Ready';
  };
  paint();

  const all = Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    loadAllModels(() => { modelsDone++; paint(); }),
    audio.preload((d, t) => { soundsDone = d; soundsTotal = t; paint(); }),
    new Promise<void>((res) => { const img = new Image(); img.onload = img.onerror = () => res(); img.src = '/asteroid-rock.png'; }),
  ]);
  await all;
  modelsDone = modelsTotal; soundsDone = soundsTotal; paint();
  await new Promise((r) => setTimeout(r, 250));
  clearInterval(tipTimer);
  root.classList.add('out');
  setTimeout(() => root.remove(), 450);
}
