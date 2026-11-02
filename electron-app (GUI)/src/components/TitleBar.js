import React from 'react';
import { useNav } from '../App';

export default function TitleBar() {
  const { page } = useNav();

  const crumbs = {
    home:     null,
    server:   'SERVER MODE',
    client:   'CLIENT MODE',
    settings: 'SETTINGS',
  };

  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <div className="brand-icon">⬡</div>
        TouchBridge
      </div>

      <div className="titlebar-center">
        {crumbs[page] && (
          <div className="titlebar-crumb">
            HOME <span>/</span> <span>{crumbs[page]}</span>
          </div>
        )}
      </div>

      <div className="titlebar-actions">
        <button className="win-btn" onClick={() => window.api?.minimize()} title="Minimize">—</button>
        <button className="win-btn" onClick={() => window.api?.maximize()} title="Maximize">□</button>
        <button className="win-btn close" onClick={() => window.api?.close()} title="Close">✕</button>
      </div>
    </div>
  );
}
