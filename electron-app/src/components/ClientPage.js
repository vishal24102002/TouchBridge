import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNav } from '../App';

// All commands supported by server_2.py
const SHORTCUTS = [
  // Row 1 - Common
  { label: 'Ctrl+C', cmd: 'shortcut:ctrl_c' },
  { label: 'Ctrl+V', cmd: 'shortcut:ctrl_v' },
  { label: 'Ctrl+X', cmd: 'shortcut:ctrl_x' },
  { label: 'Ctrl+Z', cmd: 'shortcut:ctrl_z' },
  { label: 'Ctrl+A', cmd: 'shortcut:ctrl_a' },
  { label: 'Ctrl+Tab', cmd: 'shortcut:ctrl_tab' },
  // Row 2 - Nav
  { label: '↑', cmd: 'shortcut:arrow_up', accent: true },
  { label: '↓', cmd: 'shortcut:arrow_down', accent: true },
  { label: '←', cmd: 'shortcut:arrow_left', accent: true },
  { label: '→', cmd: 'shortcut:arrow_right', accent: true },
  { label: 'PgUp', cmd: 'shortcut:page_up' },
  { label: 'PgDn', cmd: 'shortcut:page_down' },
  // Row 3 - Special
  { label: '⌫ Bksp', cmd: 'shortcut:backspace' },
  { label: '↵ Enter', cmd: 'shortcut:enter' },
  { label: 'Esc', cmd: 'shortcut:escape' },
  { label: 'Alt+Tab', cmd: 'shortcut:alt_tab' },
  { label: 'Alt+F4', cmd: 'shortcut:alt_f4' },
  { label: 'Win+D', cmd: 'shortcut:win_d' },
  // Row 4 - Apps
  { label: '🌐 Browser', cmd: 'open_browser' },
  { label: '📁 Folder', cmd: 'custom:open_folder' },
  { label: '🖥 Terminal', cmd: 'open_terminal' },
  { label: '🎵 Play/Pause', cmd: 'media_play_pause' },
  { label: '🔊 Vol+', cmd: 'volume_up' },
  { label: '🔇 Mute', cmd: 'volume_mute' },
];

export default function ClientPage() {
  const { setPage } = useNav();

  // Connection form
  const [host, setHost] = useState('');
  const [screenPort, setScreenPort] = useState('8080');
  const [controlPort, setControlPort] = useState('9999');

  // State
  const [phase, setPhase] = useState('form'); // form | connected | error
  const [errorMsg, setErrorMsg] = useState('');
  const [screenDataUrl, setScreenDataUrl] = useState(null);
  const [controlEnabled, setControlEnabled] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [fps, setFps] = useState(0);
  const [typeText, setTypeText] = useState('');
  const [lastCmdStatus, setLastCmdStatus] = useState('');

  const captureInterval = useRef(null);
  const fpsCounter = useRef(0);
  const fpsTimer = useRef(null);

  // Load saved host
  useEffect(() => {
    window.api?.get('lastHost').then(h => { if (h) setHost(h); });
    window.api?.get('lastScreenPort').then(p => { if (p) setScreenPort(p); });
    window.api?.get('lastControlPort').then(p => { if (p) setControlPort(p); });
    return () => stopCapture();
  }, []);

  const connect = async () => {
    if (!host.trim()) { setErrorMsg('Enter a host IP address'); return; }
    setErrorMsg('');
    setPhase('connecting');

    // Save prefs
    window.api?.set('lastHost', host.trim());
    window.api?.set('lastScreenPort', screenPort);
    window.api?.set('lastControlPort', controlPort);

    // Test screen connection via a single capture
    const data = await window.api?.captureScreen(host.trim(), parseInt(screenPort));
    if (!data) {
      setErrorMsg(`Cannot reach ${host}:${screenPort} — is the server running?`);
      setPhase('form');
      return;
    }

    setScreenDataUrl(data);
    setPhase('connected');
    startCapture();
  };

  const startCapture = useCallback(() => {
    setIsCapturing(true);
    fpsCounter.current = 0;

    fpsTimer.current = setInterval(() => {
      setFps(fpsCounter.current);
      fpsCounter.current = 0;
    }, 1000);

    // Poll for new frames
    captureInterval.current = setInterval(async () => {
      const data = await window.api?.captureScreen(host.trim(), parseInt(screenPort));
      if (data) {
        setScreenDataUrl(data);
        fpsCounter.current++;
      }
    }, 200); // ~5fps polling (server is request-response style)
  }, [host, screenPort]);

  const stopCapture = () => {
    clearInterval(captureInterval.current);
    clearInterval(fpsTimer.current);
    setIsCapturing(false);
  };

  const disconnect = async () => {
    stopCapture();
    await window.api?.controlDisconnect();
    setPhase('form');
    setScreenDataUrl(null);
    setControlEnabled(false);
  };

  const enableControl = async () => {
    const res = await window.api?.controlConnect(host.trim(), parseInt(controlPort));
    if (res?.ok) {
      setControlEnabled(true);
      setLastCmdStatus('Control connected');
    } else {
      setLastCmdStatus(`Control error: ${res?.error}`);
    }
  };

  const disableControl = async () => {
    await window.api?.controlDisconnect();
    setControlEnabled(false);
    setLastCmdStatus('Control disconnected');
  };

  const sendCmd = async (cmd) => {
    if (!controlEnabled) return;
    const res = await window.api?.controlSend(cmd);
    setLastCmdStatus(res?.ok ? `✓ ${cmd}` : `✗ ${cmd}: ${res?.error}`);
  };

  const sendMouseMove = async (e) => {
    if (!controlEnabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dx = Math.round(e.movementX);
    const dy = Math.round(e.movementY);
    if (dx !== 0 || dy !== 0) sendCmd(`mouse_move:${dx},${dy}`);
  };

  const sendMouseClick = async (e) => {
    if (!controlEnabled) return;
    if (e.button === 2) sendCmd('mouse_right_click');
    else if (e.detail === 2) sendCmd('mouse_double_click');
    else sendCmd('mouse_click');
  };

  const sendTypeText = async () => {
    if (!typeText.trim()) return;
    await sendCmd(`key:${typeText}`);
    setTypeText('');
  };

  // ── FORM ─────────────────────────────────────────────────────────────────────
  if (phase === 'form' || phase === 'connecting') {
    return (
      <div className="panel">
        <div className="sidebar">
          <div className="sidebar-header">
            <button className="back-btn" onClick={() => setPage('home')}>←</button>
            <div>
              <div className="sidebar-title">Client Mode</div>
              <div className="sidebar-sub">CONNECT TO REMOTE</div>
            </div>
          </div>

          <div className="box">
            <div className="box-title">Server Address</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="field">
                <label className="field-label">Host / IP Address</label>
                <input
                  className="field-input"
                  placeholder="192.168.1.100"
                  value={host}
                  onChange={e => setHost(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && connect()}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div className="field">
                  <label className="field-label">Screen Port</label>
                  <input
                    className="field-input"
                    value={screenPort}
                    onChange={e => setScreenPort(e.target.value)}
                    placeholder="8080"
                  />
                </div>
                <div className="field">
                  <label className="field-label">Control Port</label>
                  <input
                    className="field-input"
                    value={controlPort}
                    onChange={e => setControlPort(e.target.value)}
                    placeholder="9999"
                  />
                </div>
              </div>
            </div>
          </div>

          {errorMsg && <div className="error-msg">{errorMsg}</div>}

          <div className="mt-auto">
            <button
              className="btn btn-primary"
              onClick={connect}
              disabled={phase === 'connecting'}
            >
              {phase === 'connecting' ? '⏳ Connecting...' : '◈ Connect'}
            </button>
          </div>
        </div>

        <div className="panel-main">
          <div className="view-area">
            <div className="view-empty">
              <div className="big-icon">🔗</div>
              <p>Enter the server IP and click Connect</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── CONNECTED ─────────────────────────────────────────────────────────────────
  return (
    <div className="panel">
      {/* Sidebar */}
      <div className="sidebar" style={{ width: 260 }}>
        <div className="sidebar-header">
          <button className="back-btn" onClick={disconnect}>←</button>
          <div>
            <div className="sidebar-title">Client Mode</div>
            <div className="sidebar-sub">CONNECTED</div>
          </div>
        </div>

        <div className={`status-badge ${controlEnabled ? 'active' : 'connecting'}`}>
          <div className="status-dot" />
          {controlEnabled ? 'Control Active' : 'View Only'}
        </div>

        <div className="session-info">
          <div className="info-row">
            <span className="info-key">HOST</span>
            <span className="info-val">{host}</span>
          </div>
          <div className="info-row">
            <span className="info-key">SCREEN</span>
            <span className="info-val green">:{screenPort}</span>
          </div>
          <div className="info-row">
            <span className="info-key">CONTROL</span>
            <span className="info-val green">:{controlPort}</span>
          </div>
          <div className="info-row">
            <span className="info-key">FPS</span>
            <span className="info-val">{fps}</span>
          </div>
        </div>

        {/* Control toggle */}
        <div className="box">
          <div className="box-title">Remote Control</div>
          {!controlEnabled ? (
            <button className="btn btn-success" onClick={enableControl}>
              🖱 Enable Control
            </button>
          ) : (
            <>
              <button className="btn btn-danger" onClick={disableControl} style={{ marginBottom: 10 }}>
                ✕ Disable Control
              </button>

              {/* Type text */}
              <div className="field">
                <label className="field-label">Type Text</label>
                <div style={{ display: 'flex', gap: 5 }}>
                  <input
                    className="field-input"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="Type here..."
                    value={typeText}
                    onChange={e => setTypeText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendTypeText(); } }}
                  />
                  <button className="btn btn-icon" onClick={sendTypeText}>⏎</button>
                </div>
              </div>
            </>
          )}

          {lastCmdStatus && (
            <div style={{
              marginTop: 8, fontSize: 10, fontFamily: 'var(--font-mono)',
              color: lastCmdStatus.startsWith('✓') ? 'var(--accent-2)' : 'var(--danger)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}>
              {lastCmdStatus}
            </div>
          )}
        </div>

        {/* Shortcut pad */}
        {controlEnabled && (
          <div className="box">
            <div className="box-title">Shortcuts</div>
            <div className="ctrl-grid">
              {SHORTCUTS.map(s => (
                <button
                  key={s.cmd}
                  className={`ctrl-btn ${s.accent ? 'accent' : ''}`}
                  onClick={() => sendCmd(s.cmd)}
                  title={s.cmd}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-auto">
          <button className="btn btn-danger" onClick={disconnect}>⬡ Disconnect</button>
        </div>
      </div>

      {/* Screen view */}
      <div className="panel-main">
        <div
          className="view-area"
          style={{ cursor: controlEnabled ? 'crosshair' : 'default' }}
          onMouseMove={controlEnabled ? sendMouseMove : undefined}
          onMouseDown={controlEnabled ? sendMouseClick : undefined}
          onContextMenu={e => controlEnabled && e.preventDefault()}
        >
          {screenDataUrl ? (
            <img
              className="screen-img"
              src={screenDataUrl}
              alt="Remote Screen"
              draggable={false}
            />
          ) : (
            <div className="view-empty">
              <div className="big-icon">⏳</div>
              <p>Loading screen...</p>
            </div>
          )}
          {controlEnabled && (
            <div style={{
              position: 'absolute', top: 8, right: 8,
              background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
              borderRadius: 7, padding: '4px 11px',
              fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)',
              letterSpacing: '0.1em',
            }}>
              CONTROL ACTIVE
            </div>
          )}
        </div>

        <div className="toolbar">
          <button
            className={`btn btn-icon ${isCapturing ? 'active' : ''}`}
            onClick={isCapturing ? stopCapture : startCapture}
          >
            {isCapturing ? '⏸ Pause' : '▶ Resume'}
          </button>
          <span className="toolbar-sep" />
          {isCapturing && (
            <div className="live-badge">
              <span className="pulse-dot" style={{ width: 5, height: 5 }} />
              LIVE • {fps} FPS
            </div>
          )}
          <button className="btn btn-icon" style={{ color: 'var(--danger)' }} onClick={disconnect}>
            ✕ Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
