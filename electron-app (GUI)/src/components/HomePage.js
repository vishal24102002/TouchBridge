import React from 'react';
import { useNav } from '../App';

export default function HomePage() {
  const { setPage } = useNav();

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <div className="hero-eyebrow">
            <span className="pulse-dot" />
            CROSS-PLATFORM REMOTE DESKTOP
          </div>
          <h1 className="home-title">TouchBridge</h1>
          <p className="home-sub">
            Secure screen sharing and remote control for Linux and Windows. Powered by Python.
          </p>
        </div>

        <div className="mode-grid">
          <div className="mode-card" onClick={async () => { await window.api?.startServer(); setPage('server'); }}>
            <div className="card-icon-wrap">🖥️</div>
            <h3>Host Session</h3>
            <p>
              Share your screen with remote users. Launch the Python server and receive
              connections on your machine.
            </p>
            <div className="card-pill">⬡ SERVER MODE</div>
          </div>

          <div className="mode-card green-variant" onClick={() => setPage('client')}>
            <div className="card-icon-wrap">🔗</div>
            <h3>Connect Remote</h3>
            <p>
              View and control a remote machine. Connect to a running server
              using its IP address.
            </p>
            <div className="card-pill">◈ CLIENT MODE</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" onClick={() => setPage('settings')}>
            ⚙ Settings &amp; Theme
          </button>
        </div>
      </div>
    </div>
  );
}