import React, { createContext, useContext, useState, useEffect } from 'react';
import './App.css';
import TitleBar from './components/TitleBar';
import HomePage from './components/HomePage';
import ServerPage from './components/ServerPage';
import ClientPage from './components/ClientPage';
import SettingsPage from './components/SettingsPage';

// ─── Theme Definitions ────────────────────────────────────────────────────────
export const THEMES = {
  obsidian: {
    name: 'Obsidian',
    emoji: '🖤',
    '--bg-base':    '#0b0c10',
    '--bg-1':       '#12141a',
    '--bg-2':       '#181b23',
    '--bg-3':       '#1f2330',
    '--bg-4':       '#262c3d',
    '--border':     'rgba(99,115,160,0.14)',
    '--border-hi':  'rgba(99,115,200,0.3)',
    '--accent':     '#4f8fff',
    '--accent-2':   '#38d9a9',
    '--accent-glow':'rgba(79,143,255,0.35)',
    '--text-0':     '#e8ecf4',
    '--text-1':     '#9aa3b8',
    '--text-2':     '#535d75',
    '--text-3':     '#2e3448',
    '--danger':     '#ff5c7a',
    '--warn':       '#ffbd2e',
  },
  aurora: {
    name: 'Aurora',
    emoji: '🌌',
    '--bg-base':    '#07090f',
    '--bg-1':       '#0d1018',
    '--bg-2':       '#121620',
    '--bg-3':       '#181d2c',
    '--bg-4':       '#1e2538',
    '--border':     'rgba(100,60,200,0.18)',
    '--border-hi':  'rgba(140,80,255,0.35)',
    '--accent':     '#9b59ff',
    '--accent-2':   '#00d4aa',
    '--accent-glow':'rgba(155,89,255,0.4)',
    '--text-0':     '#f0ecff',
    '--text-1':     '#a899cc',
    '--text-2':     '#5a4d7a',
    '--text-3':     '#2d2545',
    '--danger':     '#ff4d88',
    '--warn':       '#ffaa33',
  },
  ember: {
    name: 'Ember',
    emoji: '🔥',
    '--bg-base':    '#0c0906',
    '--bg-1':       '#160e09',
    '--bg-2':       '#1c130e',
    '--bg-3':       '#241a13',
    '--bg-4':       '#2e221a',
    '--border':     'rgba(180,80,20,0.18)',
    '--border-hi':  'rgba(230,110,40,0.35)',
    '--accent':     '#ff7b2e',
    '--accent-2':   '#ffcc44',
    '--accent-glow':'rgba(255,123,46,0.4)',
    '--text-0':     '#fff2e8',
    '--text-1':     '#cc9978',
    '--text-2':     '#7a5038',
    '--text-3':     '#3d2518',
    '--danger':     '#ff3d5a',
    '--warn':       '#ffdd55',
  },
  arctic: {
    name: 'Arctic',
    emoji: '🧊',
    '--bg-base':    '#f0f4f8',
    '--bg-1':       '#e4eaf2',
    '--bg-2':       '#d8e0eb',
    '--bg-3':       '#c8d4e4',
    '--bg-4':       '#b8c8da',
    '--border':     'rgba(80,120,180,0.18)',
    '--border-hi':  'rgba(60,100,200,0.35)',
    '--accent':     '#2563eb',
    '--accent-2':   '#0ea5e9',
    '--accent-glow':'rgba(37,99,235,0.25)',
    '--text-0':     '#0f172a',
    '--text-1':     '#334155',
    '--text-2':     '#64748b',
    '--text-3':     '#94a3b8',
    '--danger':     '#ef4444',
    '--warn':       '#f59e0b',
  },
  matrix: {
    name: 'Matrix',
    emoji: '💚',
    '--bg-base':    '#000400',
    '--bg-1':       '#020a02',
    '--bg-2':       '#041004',
    '--bg-3':       '#061806',
    '--bg-4':       '#082208',
    '--border':     'rgba(0,200,50,0.16)',
    '--border-hi':  'rgba(0,255,65,0.3)',
    '--accent':     '#00ff41',
    '--accent-2':   '#00cc33',
    '--accent-glow':'rgba(0,255,65,0.35)',
    '--text-0':     '#ccffcc',
    '--text-1':     '#55cc55',
    '--text-2':     '#226622',
    '--text-3':     '#0f330f',
    '--danger':     '#ff3300',
    '--warn':       '#ffcc00',
  },
};

export const ThemeCtx = createContext({});
export const NavCtx   = createContext({});

export function useTheme() { return useContext(ThemeCtx); }
export function useNav()   { return useContext(NavCtx); }

export default function App() {
  const [themeName, setThemeName] = useState('obsidian');
  const [page, setPage] = useState('home'); // home | server | client | settings
  const [serverInfo, setServerInfo] = useState({ host: '127.0.0.1', screenPort: 8080, controlPort: 9999 });
  const [networkInfo, setNetworkInfo] = useState(null);

  // Load persisted theme
  useEffect(() => {
    window.api?.get('theme').then(t => { if (t && THEMES[t]) setThemeName(t); });
    window.api?.getNetwork().then(info => setNetworkInfo(info));
  }, []);

  // Apply CSS vars
  useEffect(() => {
    const theme = THEMES[themeName];
    const root = document.documentElement;
    Object.entries(theme).forEach(([k, v]) => {
      if (k.startsWith('--')) root.style.setProperty(k, v);
    });
  }, [themeName]);

  const changeTheme = (t) => {
    setThemeName(t);
    window.api?.set('theme', t);
  };

  return (
    <ThemeCtx.Provider value={{ themeName, changeTheme, themes: THEMES }}>
      <NavCtx.Provider value={{ page, setPage, serverInfo, setServerInfo, networkInfo }}>
        <div className={`app-root theme-${themeName}`}>
          <TitleBar />
          <div className="app-body">
            {page === 'home'     && <HomePage />}
            {page === 'server'   && <ServerPage />}
            {page === 'client'   && <ClientPage />}
            {page === 'settings' && <SettingsPage />}
          </div>
        </div>
      </NavCtx.Provider>
    </ThemeCtx.Provider>
  );
}
