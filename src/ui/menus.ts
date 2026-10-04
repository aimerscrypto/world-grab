import type { Difficulty } from '../config';
import { REGIONS, type RegionId } from '../map/regions';
import type { Quality } from '../render/stage';
import { ICONS } from './icons';
import { fmtTime } from './hud';
import { bestFor, settings, stats, totalWins } from '../game/stats';

export type ScreenName = 'none' | 'title' | 'maps' | 'setup' | 'howto' | 'settings' | 'pause' | 'results';

export interface MenuHandlers {
  click(): void;
  play(): void;
  goTitle(): void;
  openMaps(): void;
  startMatch(o: { region: RegionId; difficulty: Difficulty; bots: number; playerStart: number }): void;
  resume(): void;
  restart(): void;
  quit(): void;
  playAgain(): void;
  setSound(on: boolean): void;
  setMusic(on: boolean): void;
  setQuality(q: Quality): void;
  replayTutorial(): void;
  resetStats(): void;
  countryList(region: RegionId): Promise<{ idx: number; name: string }[]>;
  regionCount(region: RegionId): Promise<number>;
  silhouette(region: RegionId): Promise<string>;
}

export interface ResultsData {
  win: boolean;
  region: string;
  difficulty: Difficulty;
  seconds: number;
  captured: number;
  troopsSent: number;
  biggestBattle: number;
  record: boolean;
}

const DIFF_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const TOTAL_FLAGS = 249;

function el<T extends HTMLElement = HTMLDivElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

/** Animated number count-up for stats. */
export function countUp(node: HTMLElement, to: number, fmt: (v: number) => string = (v) => String(Math.round(v)), dur = 900) {
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(to * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** All full-screen menus (title, map select, setup, how-to, settings, pause, results). */
export class Menus {
  readonly root: HTMLDivElement;
  private screens: Record<Exclude<ScreenName, 'none'>, HTMLDivElement>;
  current: ScreenName = 'none';
  private settingsReturn: ScreenName = 'title';
  private setupRegion: RegionId = 'europe';
  private setupDiff: Difficulty = settings.lastDifficulty;
  private setupBots = settings.lastBots;
  private replayBar: HTMLElement;
  private silhouettes = new Map<RegionId, string>();

  constructor(container: HTMLElement, private h: MenuHandlers) {
    this.root = el(`<div class="ui-layer menus"></div>`);
    container.appendChild(this.root);
    this.screens = {
      title: this.buildTitle(),
      maps: el(`<div class="screen dim maps"></div>`),
      setup: el(`<div class="screen dim setup"></div>`),
      howto: this.buildHowto(),
      settings: el(`<div class="screen dim settings"></div>`),
      pause: this.buildPause(),
      results: el(`<div class="screen results"></div>`),
    };
    for (const s of Object.values(this.screens)) this.root.appendChild(s);
    this.replayBar = document.createElement('i');
  }

  private btn(sel: string, scope: HTMLElement, fn: () => void) {
    const b = scope.querySelector<HTMLButtonElement>(sel);
    if (b) b.onclick = () => { this.h.click(); fn(); };
  }

  show(name: ScreenName) {
    this.current = name;
    for (const [k, s] of Object.entries(this.screens)) s.classList.toggle('show', k === name);
    this.root.style.pointerEvents = name === 'none' ? 'none' : '';
  }

  // ------------------------------------------------------------ title
  private buildTitle(): HTMLDivElement {
    const letters = (word: string, offset: number) =>
      [...word].map((ch, i) => `<span class="l${i === word.length - 1 ? ' wiggle' : ''}" style="animation-delay:${(offset + i) * 0.07}s">${ch}</span>`).join('');
    const s = el(`
      <div class="screen title-screen">
        <div>
          <div class="logo"><span class="w">${letters('WORLD', 0)}</span><br><span class="w grab">${letters('GRAB', 5)}</span></div>
          <div class="tagline">Drag. Conquer. Collect every flag.</div>
        </div>
        <div class="title-menu">
          <button class="btn big gold play">${ICONS.play}Play</button>
          <button class="btn ghost howto">How to play</button>
          <button class="btn ghost settings">Settings</button>
          <div class="title-foot"></div>
        </div>
      </div>`);
    this.btn('.play', s, () => this.h.play());
    this.btn('.howto', s, () => this.show('howto'));
    this.btn('.settings', s, () => this.openSettings('title'));
    return s;
  }

  refreshTitle() {
    const foot = this.screens.title.querySelector('.title-foot')!;
    const w = totalWins();
    foot.textContent = stats.matches
      ? `${w} win${w === 1 ? '' : 's'} · ${stats.flags.length}/${TOTAL_FLAGS} flags collected`
      : 'A real-time conquest game on a real world map';
  }

  // ------------------------------------------------------------ map select
  async openMaps() {
    const s = this.screens.maps;
    s.innerHTML = `
      <div class="panel glass wide">
        <div class="head"><button class="icon-btn back" aria-label="Back">${ICONS.back}</button><h2>Choose a battlefield</h2></div>
        <div class="map-grid"></div>
      </div>`;
    this.btn('.back', s, () => this.h.goTitle());
    const grid = s.querySelector('.map-grid')!;
    const order: RegionId[] = ['europe', 'africa', 'asia', 'namerica', 'samerica', 'oceania', 'world'];
    order.forEach((id, k) => {
      const def = REGIONS.find((r) => r.id === id)!;
      const best = bestFor(id);
      const card = el<HTMLButtonElement>(`
        <button class="map-card${id === 'world' ? ' world' : ''}" style="animation-delay:${k * 0.05}s">
          ${best ? `<span class="best">🏆 ${DIFF_LABEL[best.difficulty]} · ${fmtTime(best.seconds)}</span>` : ''}
          <svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid meet"><path d="${this.silhouettes.get(id) ?? ''}"/></svg>
          <div class="name">${def.name}</div>
          <div class="meta"><span class="cnt">…</span><span class="len"></span></div>
        </button>`);
      card.onclick = () => { this.h.click(); this.openSetup(id); };
      grid.appendChild(card);
      this.h.regionCount(id).then((n) => {
        card.querySelector('.cnt')!.textContent = `${n} countries`;
        card.querySelector('.len')!.textContent = `~${Math.max(2, Math.round(n * 0.15 + 1))} min`;
      });
      if (!this.silhouettes.has(id)) {
        this.h.silhouette(id).then((d) => {
          this.silhouettes.set(id, d);
          card.querySelector('path')!.setAttribute('d', d);
        });
      }
    });
    this.show('maps');
  }

  // ------------------------------------------------------------ setup
  async openSetup(region: RegionId) {
    this.setupRegion = region;
    const def = REGIONS.find((r) => r.id === region)!;
    const s = this.screens.setup;
    s.innerHTML = `
      <div class="panel glass">
        <div class="head"><button class="icon-btn back" aria-label="Back">${ICONS.back}</button><h2>${def.name}</h2></div>
        <p style="text-align:center;margin-top:-6px">${def.blurb}</p>
        <div class="field"><label>Difficulty</label><div class="seg diff">
          ${(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => `<button data-v="${d}" class="${d === this.setupDiff ? 'on' : ''}">${DIFF_LABEL[d]}</button>`).join('')}
        </div></div>
        <div class="field"><label>Rival empires</label><div class="seg bots">
          ${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}" class="${n === this.setupBots ? 'on' : ''}">${n}</button>`).join('')}
        </div></div>
        <div class="field"><label>Starting country</label><div class="start-pick"><select><option value="-1">🎲 Random</option></select></div></div>
        <div class="row" style="margin-top:14px"><button class="btn big gold start" style="width:100%">Start!</button></div>
      </div>`;
    this.btn('.back', s, () => this.openMaps());
    const seg = (sel: string, fn: (v: string) => void) => {
      const box = s.querySelector(sel)!;
      box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.onclick = () => {
          this.h.click();
          box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          fn(b.dataset.v!);
        };
      });
    };
    seg('.diff', (v) => (this.setupDiff = v as Difficulty));
    seg('.bots', (v) => (this.setupBots = Number(v)));
    const select = s.querySelector('select')!;
    this.btn('.start', s, () => {
      settings.lastDifficulty = this.setupDiff;
      settings.lastBots = this.setupBots;
      this.h.startMatch({ region, difficulty: this.setupDiff, bots: this.setupBots, playerStart: Number(select.value) });
    });
    this.show('setup');
    const list = await this.h.countryList(region);
    if (this.setupRegion !== region) return;
    for (const c of list) {
      const o = document.createElement('option');
      o.value = String(c.idx);
      o.textContent = c.name;
      select.appendChild(o);
    }
  }

  // ------------------------------------------------------------ how to play
  private buildHowto(): HTMLDivElement {
    const s = el(`
      <div class="screen dim howto"><div class="panel glass">
        <h2>How to play</h2>
        <div class="howto-steps">
          <div class="howto-step"><div class="ic">👆</div><div class="tx"><b>Drag</b> from one of your countries (blue) to a neighbour to send 60% of its troops.</div></div>
          <div class="howto-step"><div class="ic">✌️</div><div class="tx"><b>Drag through</b> several of your countries before releasing to attack from all of them at once.</div></div>
          <div class="howto-step"><div class="ic">🛡️</div><div class="tx">Release on <b>your own</b> country to reinforce it. Islands are linked by dotted sea routes.</div></div>
          <div class="howto-step"><div class="ic">🌍</div><div class="tx">Owned countries grow troops — bigger ones grow faster. <b>Own every country</b> to win!</div></div>
        </div>
        <div class="row"><button class="btn ghost tut">Play tutorial</button><button class="btn gold ok">Got it!</button></div>
      </div></div>`);
    this.btn('.ok', s, () => this.show('title'));
    this.btn('.tut', s, () => this.h.replayTutorial());
    return s;
  }

  // ------------------------------------------------------------ settings
  openSettings(returnTo: ScreenName) {
    this.settingsReturn = returnTo;
    const s = this.screens.settings;
    const sw = (on: boolean) => `<button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"></button>`;
    s.innerHTML = `
      <div class="panel glass">
        <div class="head"><button class="icon-btn back" aria-label="Back">${ICONS.back}</button><h2>Settings</h2></div>
        <div class="toggle-row"><span>Sound</span>${sw(!settings.muted)}</div>
        <div class="toggle-row music"><span>Music</span>${sw(settings.music)}</div>
        <div class="field"><label>Graphics quality</label><div class="seg quality">
          ${(['auto', 'high', 'medium', 'low'] as Quality[]).map((q) => `<button data-v="${q}" class="${q === settings.quality ? 'on' : ''}">${q[0].toUpperCase() + q.slice(1)}</button>`).join('')}
        </div></div>
        <div class="stats-grid">
          <div class="stat"><div class="v">${totalWins()}</div><div class="k">Wins</div></div>
          <div class="stat"><div class="v">${stats.matches}</div><div class="k">Matches</div></div>
          <div class="stat"><div class="v">${stats.totalCaptured}</div><div class="k">Countries taken</div></div>
          <div class="stat"><div class="v">${stats.flags.length}/${TOTAL_FLAGS}</div><div class="k">Flags collected</div></div>
        </div>
        <div class="row"><button class="btn small ghost tut">Replay tutorial</button><button class="btn small red reset">Reset stats</button></div>
      </div>`;
    this.btn('.back', s, () => this.show(this.settingsReturn));
    const toggles = s.querySelectorAll<HTMLButtonElement>('.switch');
    toggles[0].onclick = () => {
      const on = !toggles[0].classList.contains('on');
      toggles[0].classList.toggle('on', on);
      this.h.setSound(on);
      this.h.click();
    };
    toggles[1].onclick = () => {
      this.h.click();
      const on = !toggles[1].classList.contains('on');
      toggles[1].classList.toggle('on', on);
      this.h.setMusic(on);
    };
    const q = s.querySelector('.quality')!;
    q.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      b.onclick = () => {
        this.h.click();
        q.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.h.setQuality(b.dataset.v as Quality);
      };
    });
    this.btn('.tut', s, () => this.h.replayTutorial());
    const reset = s.querySelector<HTMLButtonElement>('.reset')!;
    reset.onclick = () => {
      this.h.click();
      if (reset.dataset.armed) {
        this.h.resetStats();
        this.openSettings(this.settingsReturn);
      } else {
        reset.dataset.armed = '1';
        reset.textContent = 'Tap again to confirm';
      }
    };
    this.show('settings');
  }

  // ------------------------------------------------------------ pause
  private buildPause(): HTMLDivElement {
    const s = el(`
      <div class="screen dim pause"><div class="panel glass narrow">
        <h2>Paused</h2>
        <div class="col">
          <button class="btn green resume">${ICONS.play}Resume</button>
          <button class="btn ghost restart">Restart</button>
          <button class="btn ghost settings">Settings</button>
          <button class="btn red quit">Quit to menu</button>
        </div>
      </div></div>`);
    this.btn('.resume', s, () => this.h.resume());
    this.btn('.restart', s, () => this.h.restart());
    this.btn('.settings', s, () => this.openSettings('pause'));
    this.btn('.quit', s, () => this.h.quit());
    return s;
  }

  // ------------------------------------------------------------ results
  openResults(r: ResultsData) {
    const s = this.screens.results;
    s.className = `screen results ${r.win ? 'win' : 'lose'}`;
    s.innerHTML = `
      <div class="panel glass">
        <div class="big-title">${r.win ? 'VICTORY!' : 'DEFEAT'}</div>
        <p>${r.region} · ${DIFF_LABEL[r.difficulty]}${r.record ? ' · <b style="color:var(--gold)">New best time!</b>' : ''}</p>
        <div class="stats-grid">
          <div class="stat"><div class="v t">0:00</div><div class="k">Time</div></div>
          <div class="stat"><div class="v c">0</div><div class="k">Countries captured</div></div>
          <div class="stat"><div class="v s">0</div><div class="k">Troops sent</div></div>
          <div class="stat"><div class="v b">0</div><div class="k">Biggest battle</div></div>
        </div>
        <div class="replay-tag">▶ Match timelapse</div>
        <div class="replay-bar"></div>
        <div class="row">
          <button class="btn gold again">${r.win ? 'Play again' : 'Try again'}</button>
          <button class="btn ghost maps">Maps</button>
          <button class="btn ghost menu">${ICONS.home}</button>
        </div>
      </div>`;
    s.querySelector('.replay-bar')!.appendChild(this.replayBar);
    this.replayBar.style.width = '0%';
    this.btn('.again', s, () => this.h.playAgain());
    this.btn('.maps', s, () => this.h.openMaps());
    this.btn('.menu', s, () => this.h.quit());
    this.show('results');
    countUp(s.querySelector('.t')!, r.seconds, (v) => fmtTime(v));
    countUp(s.querySelector('.c')!, r.captured);
    countUp(s.querySelector('.s')!, r.troopsSent);
    countUp(s.querySelector('.b')!, r.biggestBattle);
  }

  setReplayProgress(k: number) {
    this.replayBar.style.width = `${Math.round(k * 100)}%`;
  }
}
