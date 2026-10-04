import { CONFIG } from '../config';

/**
 * Every sound in the game is synthesised here with the Web Audio API —
 * no audio files. The context is created lazily on the first user gesture.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private muted = false;
  private musicOn = true;
  private lastPlay = new Map<string, number>();
  private musicTimer: number | null = null;
  private nextBeat = 0;
  private beat = 0;
  private delayIn!: GainNode;

  constructor(muted: boolean, music: boolean) {
    this.muted = muted;
    this.musicOn = music;
    const unlock = () => {
      this.ensure();
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : CONFIG.audio.masterVolume;
      this.master.connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = CONFIG.audio.sfxVolume;
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicOn ? CONFIG.audio.musicVolume : 0;
      this.musicBus.connect(this.master);
      // shared echo for music + some sfx
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.42;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      this.delayIn = ctx.createGain();
      this.delayIn.gain.value = 0.5;
      this.delayIn.connect(delay);
      delay.connect(lp).connect(fb).connect(delay);
      lp.connect(this.master);
      // white noise buffer
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startMusic();
      return ctx;
    } catch {
      this.ctx = null;
      return null;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : CONFIG.audio.masterVolume, this.ctx.currentTime, 0.05);
  }

  setMusic(on: boolean) {
    this.musicOn = on;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(on ? CONFIG.audio.musicVolume : 0, this.ctx.currentTime, 0.4);
  }

  /** rate limiter: returns false if `key` played less than `gap` seconds ago */
  private gate(key: string, gap: number): boolean {
    const now = performance.now() / 1000;
    const last = this.lastPlay.get(key) ?? -1;
    if (now - last < gap) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  // ------------------------------------------------------------ primitives
  private tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; at?: number; slideTo?: number; attack?: number; bus?: AudioNode; echo?: number } = {}) {
    const ctx = this.ctx!;
    const t = opts.at ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t + dur);
    const g = ctx.createGain();
    const v = opts.vol ?? 0.2;
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(opts.bus ?? this.sfxBus);
    if (opts.echo) {
      const e = ctx.createGain();
      e.gain.value = opts.echo;
      g.connect(e).connect(this.delayIn);
    }
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseBurst(dur: number, opts: { vol?: number; at?: number; type?: BiquadFilterType; freq?: number; freqTo?: number; q?: number } = {}) {
    const ctx = this.ctx!;
    const t = opts.at ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1000, t);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(opts.freqTo, t + dur);
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    const v = opts.vol ?? 0.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.03, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------ sounds
  play(name: string, arg = 0) {
    if (name === 'mute') { this.setMuted(arg === 1); return; }
    if (name === 'music') { this.setMusic(arg === 1); return; }
    const ctx = this.ensure();
    if (!ctx || this.muted || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    switch (name) {
      case 'click':
        if (!this.gate('click', 0.04)) return;
        this.tone(900, 0.07, { type: 'triangle', vol: 0.12, slideTo: 1300 });
        break;
      case 'select':
        if (!this.gate('select', 0.05)) return;
        this.tone(620, 0.09, { type: 'triangle', vol: 0.12, slideTo: 760 });
        break;
      case 'hover':
        if (!this.gate('hover', 0.06)) return;
        this.tone(1250, 0.05, { type: 'sine', vol: 0.06 });
        break;
      case 'invalid':
        if (!this.gate('invalid', 0.2)) return;
        this.tone(150, 0.12, { type: 'square', vol: 0.05, slideTo: 110 });
        break;
      case 'cancel':
        break;
      case 'send': {
        if (!this.gate('send', 0.06)) return;
        const v = Math.min(0.32, 0.12 + Math.log10(1 + arg) * 0.08);
        this.noiseBurst(0.42, { vol: v, type: 'bandpass', freq: 380, freqTo: 2600, q: 1.4 });
        this.tone(220, 0.25, { type: 'sine', vol: 0.06, slideTo: 440 });
        break;
      }
      case 'botsend':
        if (!this.gate('botsend', 0.25)) return;
        this.noiseBurst(0.3, { vol: 0.04, type: 'bandpass', freq: 500, freqTo: 1600, q: 1.2 });
        break;
      case 'march':
        if (!this.gate('march', CONFIG.audio.marchTickInterval)) return;
        this.noiseBurst(0.035, { vol: 0.025 + Math.random() * 0.015, type: 'highpass', freq: 2500 + Math.random() * 1500, q: 0.7 });
        break;
      case 'clash':
        if (!this.gate('clash', 0.07)) return;
        this.noiseBurst(0.08, { vol: 0.09, type: 'lowpass', freq: 1800 + Math.random() * 800, q: 0.8 });
        this.tone(140 + Math.random() * 40, 0.12, { type: 'sine', vol: 0.1, slideTo: 60 });
        break;
      case 'capture': {
        // player fanfare
        const base = 523.25;
        [1, 1.26, 1.5, 2].forEach((m, i) => this.tone(base * m, 0.22 + i * 0.04, { type: 'triangle', vol: 0.13, at: t + i * 0.065, echo: 0.3 }));
        this.tone(base * 2, 0.5, { type: 'sine', vol: 0.06, at: t + 0.26, echo: 0.4 });
        this.noiseBurst(0.25, { vol: 0.05, type: 'highpass', freq: 5000, at: t + 0.2 });
        break;
      }
      case 'othercapture':
        if (!this.gate('othercapture', 0.15)) return;
        this.tone(330, 0.12, { type: 'triangle', vol: 0.05, slideTo: 300 });
        break;
      case 'lost':
        this.tone(190, 0.45, { type: 'sine', vol: 0.28, slideTo: 45 });
        this.noiseBurst(0.3, { vol: 0.12, type: 'lowpass', freq: 400 });
        this.tone(233, 0.4, { type: 'triangle', vol: 0.06, at: t + 0.08, slideTo: 196 });
        break;
      case 'alarm':
        this.tone(740, 0.11, { type: 'square', vol: 0.035 });
        this.tone(587, 0.14, { type: 'square', vol: 0.035, at: t + 0.12 });
        break;
      case 'combo': {
        const n = Math.max(2, Math.min(7, arg));
        for (let i = 0; i < n + 1; i++) this.tone(660 * Math.pow(1.122, i + n), 0.12, { type: 'triangle', vol: 0.09, at: t + i * 0.045, echo: 0.25 });
        break;
      }
      case 'victory': {
        const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) => this.tone(f, 0.3, { type: 'triangle', vol: 0.14, at: t + i * 0.11, echo: 0.35 }));
        [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.tone(f, 1.6, { type: 'sine', vol: 0.07, at: t + 0.8, attack: 0.08, echo: 0.4 }));
        this.noiseBurst(0.6, { vol: 0.06, type: 'highpass', freq: 6000, at: t + 0.8 });
        break;
      }
      case 'defeat': {
        const notes = [440, 392, 329.63, 293.66];
        notes.forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', vol: 0.12, at: t + i * 0.22, slideTo: f * 0.97 }));
        this.tone(146.8, 1.6, { type: 'sine', vol: 0.12, at: t + 0.88, attack: 0.05 });
        break;
      }
      case 'start':
        for (let i = 0; i < 6; i++) this.noiseBurst(0.06, { vol: 0.05 + i * 0.012, type: 'bandpass', freq: 220, q: 2, at: t + i * 0.06 });
        [392, 523.25, 659.25].forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', vol: 0.09, at: t + 0.4 + i * 0.03, echo: 0.3 }));
        break;
      case 'pause':
        this.tone(arg ? 520 : 700, 0.08, { type: 'sine', vol: 0.08, slideTo: arg ? 400 : 900 });
        break;
      case 'eliminated':
        this.tone(300, 0.6, { type: 'sawtooth', vol: 0.04, slideTo: 80 });
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ music
  /** Gentle procedural ambient loop: slow pad chords + a sparse pentatonic arpeggio. */
  private startMusic() {
    if (!this.ctx || this.musicTimer !== null) return;
    this.nextBeat = this.ctx.currentTime + 0.3;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 120);
  }

  private scheduleMusic() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const spb = 60 / 76 / 2; // eighth notes at 76 bpm
    // chord roots (A minor - F - C - G), voiced as triads
    const chords = [
      [220, 261.63, 329.63],
      [174.61, 220, 261.63],
      [130.81, 196, 261.63],
      [196, 246.94, 293.66],
    ];
    const scale = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5];
    while (this.nextBeat < ctx.currentTime + 0.4) {
      const t = this.nextBeat;
      const bar = Math.floor(this.beat / 16) % chords.length;
      const step = this.beat % 16;
      if (step === 0) {
        for (const f of chords[bar]) {
          this.pad(f, t, spb * 16);
          this.pad(f * 1.003, t, spb * 16);
        }
        this.musicTone(chords[bar][0] / 2, spb * 15, t, 'sine', 0.09, 0.2);
      }
      // sparse arpeggio
      const pattern = [0, 3, 6, 8, 11, 14];
      if (pattern.includes(step) && (this.beat * 7) % 5 !== 0) {
        const note = scale[(this.beat * 3 + bar * 2) % scale.length];
        this.musicTone(note, 0.5, t, 'triangle', 0.035, 0.004, true);
      }
      this.nextBeat += spb;
      this.beat++;
    }
  }

  private pad(freq: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(900, t + dur * 0.5);
    f.frequency.linearRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.022, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  private musicTone(freq: number, dur: number, t: number, type: OscillatorType, vol: number, attack: number, echo = false) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.musicBus);
    if (echo) g.connect(this.delayIn);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}
