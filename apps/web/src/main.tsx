import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyTheme, readTheme } from './theme.js';
import './style.css';

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
