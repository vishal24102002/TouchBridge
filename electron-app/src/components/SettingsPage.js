import React, { useEffect, useState } from 'react';
import { useNav } from '../App';
import { useTheme, THEMES } from '../App';

export default function SettingsPage() {
  const { setPage, networkInfo } = useNav();
  const { themeName, changeTheme } = useTheme();

  const [defaultHost, setDefaultHost] = useState('');
  const [screenPort, setScreenPort] = useState('8080');
  const [controlPort, setControlPort] = useState('9999');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    window.api?.get('lastHost').then(v => { if (v) setDefaultHost(v); });
    window.api?.get('lastScreenPort').then(v => { if (v) setScreenPort(v); });
    window.api?.get('lastControlPort').then(v => { if (v) setControlPort(v); });
  }, []);

  const saveDefaults = async () => {
    await window.api?.set('lastHost', defaultHost);
    await window.api?.set('lastScreenPort', screenPort);
    await window.api?.set('lastControlPort', controlPort);
    setSavedMsg('Saved!');
    setTimeout(() => setSavedMsg(''), 2000);
  };

  return (
    <div className="app-body" style={{ overflow: 'hidden' }}>
      <div className="panel">
        <div className="sidebar">
          <div className="sidebar-header">
            <button className="back-btn" onClick={() => setPage('home')}>←</button>
            <div>
              <div className="sidebar-title">Settings</div>
              <div className="sidebar-sub">PREFERENCES</div>
            </div>
          </div>

          {networkInfo && (
            <div className="box">
              <div className="box-title">This Machine</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.9 }}>
                <div style={{ color: 'var(--text-3)' }}>HOSTNAME</div>
                <div style={{ color: 'var(--accent)' }}>{networkInfo.hostname}</div>
                <div style={{ marginTop: 6, color: 'var(--text-3)' }}>PLATFORM</div>
                <div style={{ color: 'var(--accent-2)' }}>
                  {networkInfo.platform === 'linux' ? '🐧 Linux'
                    : networkInfo.platform === 'win32' ? '🪟 Windows'
                    : networkInfo.platform === 'darwin' ? '🍎 macOS'
                    : networkInfo.platform}
                </div>
                {networkInfo.ips?.length > 0 && (
                  <>
                    <div style={{ marginTop: 6, color: 'var(--text-3)' }}>LOCAL IPs</div>
                    {networkInfo.ips.map(ip => (
                      <div key={ip} style={{ color: 'var(--accent-2)' }}>{ip}</div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="mt-auto">
            <button className="btn btn-primary" onClick={saveDefaults}>
              {savedMsg || '✓ Save'}
            </button>
          </div>
        </div>

        <div className="panel-main settings-page">
          <div className="settings-wrap">

            {/* ── Theme Picker ── */}
            <div>
              <div className="settings-section-title">Appearance — Color Theme</div>
              <div className="theme-grid">
                {Object.entries(THEMES).map(([key, theme]) => (
                  <div
                    key={key}
                    className={`theme-swatch ${themeName === key ? 'active' : ''}`}
                    onClick={() => changeTheme(key)}
                  >
                    <span className="swatch-emoji">{theme.emoji}</span>
                    <span className="swatch-name">{theme.name}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 14, padding: '12px 16px', background: 'var(--bg-2)', borderRadius: 'var(--r)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6, fontFamily: 'var(--font-mono)' }}>
                  PREVIEW — <span style={{ color: 'var(--accent)' }}>{THEMES[themeName].name}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {['btn-primary', 'btn-success', 'btn-danger', 'btn-ghost'].map(cls => (
                    <button key={cls} className={`btn ${cls}`} style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }}>
                      {cls.replace('btn-', '')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Connection Defaults ── */}
            <div>
              <div className="settings-section-title">Connection Defaults</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="field">
                  <label className="field-label">Default Server Host</label>
                  <input
                    className="field-input"
                    placeholder="192.168.1.100"
                    value={defaultHost}
                    onChange={e => setDefaultHost(e.target.value)}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field">
                    <label className="field-label">Screen Port</label>
                    <input className="field-input" value={screenPort} onChange={e => setScreenPort(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="field-label">Control Port</label>
                    <input className="field-input" value={controlPort} onChange={e => setControlPort(e.target.value)} />
                  </div>
                </div>
              </div>
            </div>

            {/* ── Server Setup ── */}
            <div>
              <div className="settings-section-title">Python Server Setup</div>
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 16, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', lineHeight: 2 }}>
                <div style={{ color: 'var(--text-3)', marginBottom: 8 }}>INSTALL DEPENDENCIES</div>
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--accent-2)' }}>
                  pip install -r requirements.txt
                </div>
                <div style={{ color: 'var(--text-3)', margin: '10px 0 8px' }}>LINUX EXTRAS (X11)</div>
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--accent)' }}>
                  sudo apt install xdotool
                </div>
                <div style={{ color: 'var(--text-3)', margin: '10px 0 8px' }}>LINUX EXTRAS (WAYLAND)</div>
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--accent)' }}>
                  sudo apt install ydotool<br />
                  sudo systemctl enable --now ydotoold
                </div>
              </div>
            </div>

            {/* ── About ── */}
            <div>
              <div className="settings-section-title">About</div>
              <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 16, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', lineHeight: 1.9 }}>
                <div><span style={{ color: 'var(--accent)' }}>TouchBridge</span> v1.0.0</div>
                <div>Electron + React + Python backend</div>
                <div>TCP sockets: port 8080 (screen) + 9999 (control)</div>
                <div style={{ color: 'var(--text-3)' }}>Linux (X11/Wayland) · Windows · macOS</div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
