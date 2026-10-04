import type { Game } from '../game/game';
import type { RegionCountry } from '../map/types';
import { ICONS } from './icons';
import { flagUrl } from './flags';

export interface HudHandlers {
  onPause(): void;
  onSpeed(): void;
  onMute(): void;
  onRecenter(): void;
  onClick?(): void;
}

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
};

/** In-match HUD: leaderboard bar, timer, pause / speed / mute and the flag drawer. */
export class Hud {
  readonly root: HTMLDivElement;
  private bar: HTMLDivElement;
  private info: HTMLDivElement;
  private segs: HTMLDivElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;
  private collectBtn: HTMLButtonElement;
  private dot: HTMLSpanElement;
  private drawer: HTMLDivElement;
  private list: HTMLDivElement;
  private countEl: HTMLDivElement;
  private collected = new Set<number>();
  private unseen = 0;
  private timer = 0;
  private lastText = '';

  constructor(container: HTMLElement, private h: HudHandlers) {
    const root = (this.root = document.createElement('div'));
    root.className = 'hud';
    root.innerHTML = `
      <div class="hud-top">
        <div class="leader glass"><div class="bar"></div><div class="info"></div></div>
        <div class="hud-btns">
          <button class="icon-btn speed" aria-label="Game speed">1x</button>
          <button class="icon-btn pause" aria-label="Pause">${ICONS.pause}</button>
        </div>
      </div>
      <div class="hud-bottom">
        <button class="icon-btn collect-btn" aria-label="Countries taken">${ICONS.flags}<span class="dot" style="display:none">0</span></button>
        <button class="icon-btn mute" aria-label="Sound">${ICONS.sound}</button>
      </div>
      <div class="hud-bottom-r">
        <button class="icon-btn recenter" aria-label="Recenter map">${ICONS.target}</button>
      </div>
      <div class="drawer glass">
        <h3>Countries taken</h3>
        <div class="count">Capture countries to collect their flags.</div>
        <div class="list"></div>
      </div>`;
    container.appendChild(root);
    this.bar = root.querySelector('.bar')!;
    this.info = root.querySelector('.info')!;
    this.pauseBtn = root.querySelector('.pause')!;
    this.speedBtn = root.querySelector('.speed')!;
    this.muteBtn = root.querySelector('.mute')!;
    this.collectBtn = root.querySelector('.collect-btn')!;
    this.dot = root.querySelector('.dot')!;
    this.drawer = root.querySelector('.drawer')!;
    this.list = root.querySelector('.list')!;
    this.countEl = root.querySelector('.drawer .count')!;
    const click = (fn: () => void) => () => { this.h.onClick?.(); fn(); };
    this.pauseBtn.onclick = click(() => h.onPause());
    this.speedBtn.onclick = click(() => h.onSpeed());
    this.muteBtn.onclick = click(() => h.onMute());
    root.querySelector<HTMLButtonElement>('.recenter')!.onclick = click(() => h.onRecenter());
    this.collectBtn.onclick = click(() => this.toggleDrawer());
  }

  show(v: boolean) {
    this.root.classList.toggle('show', v);
    if (!v) this.closeDrawer();
  }

  setFactions(game: Game) {
    this.bar.innerHTML = '';
    this.segs = game.factions.map((f) => {
      const s = document.createElement('div');
      s.className = 'seg-b';
      s.style.background = `linear-gradient(180deg, color-mix(in srgb, ${f.css} 75%, white), ${f.css})`;
      s.style.flexGrow = '0';
      this.bar.appendChild(s);
      return s;
    });
    // neutral remainder
    const s = document.createElement('div');
    s.className = 'seg-b';
    s.style.background = 'rgba(217, 205, 182, 0.35)';
    this.bar.appendChild(s);
    this.segs.push(s);
    this.collected.clear();
    this.unseen = 0;
    this.list.innerHTML = '';
    this.dot.style.display = 'none';
    this.countEl.textContent = 'Capture countries to collect their flags.';
    this.timer = 0;
    this.update(game, 1);
  }

  update(game: Game, dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    let owned = 0;
    game.factions.forEach((f, i) => {
      this.segs[i].style.flexGrow = String(f.count);
      owned += f.count;
    });
    this.segs[this.segs.length - 1].style.flexGrow = String(game.n - owned);
    const me = game.noPlayer ? null : game.factions[0];
    const text = me
      ? `<span>You <b>${me.count}</b> / ${game.n}</span><span><b>${fmtTime(game.time)}</b></span>`
      : `<span>${fmtTime(game.time)}</span>`;
    if (text !== this.lastText) { this.info.innerHTML = text; this.lastText = text; }
  }

  setPaused(p: boolean) { this.pauseBtn.innerHTML = p ? ICONS.play : ICONS.pause; this.pauseBtn.classList.toggle('on', p); }
  setSpeed(s: number) { this.speedBtn.textContent = `${s}x`; this.speedBtn.classList.toggle('on', s > 1); }
  setMuted(m: boolean) { this.muteBtn.innerHTML = m ? ICONS.mute : ICONS.sound; }

  addCollected(c: RegionCountry) {
    if (this.collected.has(c.idx)) return;
    this.collected.add(c.idx);
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `<img src="${flagUrl(c.a2)}" alt=""><div><div class="n"></div><div class="s"></div></div>`;
    item.querySelector('.n')!.textContent = c.name;
    item.querySelector('.s')!.textContent = `Capital: ${c.capital}`;
    this.list.prepend(item);
    this.countEl.textContent = `${this.collected.size} flag${this.collected.size === 1 ? '' : 's'} collected this match`;
    if (!this.drawer.classList.contains('open')) {
      this.unseen++;
      this.dot.textContent = String(this.unseen);
      this.dot.style.display = '';
      this.collectBtn.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' });
    }
  }

  toggleDrawer() {
    const open = !this.drawer.classList.contains('open');
    this.drawer.classList.toggle('open', open);
    if (open) { this.unseen = 0; this.dot.style.display = 'none'; }
  }

  closeDrawer() { this.drawer.classList.remove('open'); }

}
