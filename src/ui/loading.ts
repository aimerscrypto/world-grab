const TIPS = [
  'Bigger countries grow troops faster — but they are harder to take.',
  'Drag through several of your countries to attack with all of them at once.',
  'Drop troops on your own country to reinforce a threatened border.',
  'Dotted lines across the sea connect islands to their neighbours.',
  'Tap any country to learn its capital.',
  'Capture several countries quickly for a combo!',
  'Bots fight each other too — let them weaken each other.',
];

/** Full-screen loading overlay shown while a map is built. */
export class Loading {
  readonly root: HTMLDivElement;
  private text: HTMLDivElement;
  private tip: HTMLDivElement;
  private visible = true;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'loading';
    this.root.innerHTML = `<div class="globe">🌍</div><div class="lt">Loading…</div><div class="lbar"><i></i></div><div class="tip"></div>`;
    container.appendChild(this.root);
    this.text = this.root.querySelector('.lt')!;
    this.tip = this.root.querySelector('.tip')!;
    this.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  /** Shows the overlay and resolves once it has actually been painted. */
  show(text: string): Promise<void> {
    this.text.textContent = text;
    this.tip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.root.classList.remove('hide');
    const wasVisible = this.visible;
    this.visible = true;
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, wasVisible ? 0 : 60)));
  }

  hide() {
    this.visible = false;
    this.root.classList.add('hide');
  }
}
