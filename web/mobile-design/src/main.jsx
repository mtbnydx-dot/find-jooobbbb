import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { MobileProvider } from './lib/runtime';
import './styles.css';
import './visual-refinements.css';
import './mobile-live.css';
createRoot(document.getElementById('root')).render(<React.StrictMode><HashRouter><MobileProvider><App/></MobileProvider></HashRouter></React.StrictMode>);
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => { /* The online site remains usable when private browsing blocks installation. */ });
  });
}
