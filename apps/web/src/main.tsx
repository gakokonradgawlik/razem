import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Api } from './api.js';
import { AppController } from './offline/controller.js';
import { useControllerServices } from './offline/live.js';
import { applyTheme, readTheme } from './theme.js';
import './style.css';
import { startPwa } from './pwa.js';

if (import.meta.env.PROD) void startPwa();

function safeLocalStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
// One controller per tab: local database of the signed-in account + sync of the active app.
const controller = new AppController({ api: new Api(), storage: safeLocalStorage(), autoSync: true });
void controller.init();

function Root() {
  return <App services={useControllerServices(controller)} />;
}

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
