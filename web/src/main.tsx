import './zodConfig'; // first: it must run before any schema is built
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// Installable and opens offline (see src/sw/strategy.ts). Production only: in development a cached
// shell would hide changes.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
