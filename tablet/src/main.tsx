import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { runtime } from './core/runtime';

// A controller surface should never open a context menu on long-press.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Start sensor + 100 Hz loop BEFORE React renders, so the UI reads live values from frame one.
runtime.boot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
