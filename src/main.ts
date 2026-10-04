import '@fontsource/lilita-one/400.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './styles.css';
import { App } from './app';

const root = document.getElementById('app')!;
const app = new App(root);
app.loadRegion('europe');
