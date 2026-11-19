import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { preloadCore } from './core/create.ts';
import { App } from './ui/App.tsx';
import { applyTheme, prefs } from './ui/prefs.ts';
import './ui/styles.css';

applyTheme(prefs.get().theme);

const root = createRoot(document.getElementById('root')!);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
  void import('./ui/Fixture.tsx').then(({ Fixture }) => render(<Fixture />));
} else {
  registerSW({ immediate: true });
  if (prefs.get().core === 'wasm') preloadCore();
  render(<App />);
}
