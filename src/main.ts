import '@fontsource/lilita-one/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './styles.css';
import { App } from './app';
import { AudioEngine } from './audio/audio';
import { settings } from './game/stats';
import { PLAYER } from './game/game';

const root = document.getElementById('app')!;
const app = new App(root);

// ---- audio wiring -------------------------------------------------------
const audio = new AudioEngine(settings.muted, settings.music);
app.sfx = (name, arg) => audio.play(name, arg);
app.onGameEvent.push((e, m) => {
  if (m.attract) return;
  switch (e.type) {
    case 'send':
      if (e.owner !== PLAYER) audio.play('botsend');
      break;
    case 'clash':
      if (e.defender === PLAYER || e.attacker === PLAYER) audio.play('clash');
      break;
    case 'capture':
      if (e.to === PLAYER) audio.play('capture');
      else if (e.from === PLAYER) audio.play('lost');
      else audio.play('othercapture');
      break;
    case 'eliminated':
      audio.play('eliminated');
      break;
    default:
      break;
  }
});
app.onFrame.push(() => {
  const m = app.match;
  if (m && !m.attract && !m.game.paused && !m.game.over && m.game.inFlight[PLAYER] > 0) audio.play('march');
});

app.boot();
