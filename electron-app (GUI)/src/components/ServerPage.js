import React, { useEffect, useState, useRef } from 'react';
import { useNav } from '../App';

export default function ServerPage() {
  const { setPage, networkInfo } = useNav();
  const [logs, setLogs] = useState([]);
  const [serverStatus, setServerStatus] = useState('starting'); // starting | running | error
  const [copied, setCopied] = useState('');
  const [preview, setPreview] = useState(null); // data URL from the local capture window
  const [controlAllowed, setControlAllowedState] = useState(true);
  const logRef = useRef(null);

  useEffect(() => {
    // Listen for Python server logs
    window.api?.onServerLog((msg) => {
      setLogs(prev => [...prev.slice(-120), msg]);
      if (msg.includes('Waiting for') || msg.includes('listening')) {
        setServerStatus('running');
      }
      if (msg.includes('Error') || msg.includes('error')) {
        setServerStatus('error');
      }
    });

    // Live thumbnail of what's being captured/broadcast right now
    window.api?.onLocalPreview((dataUrl) => setPreview(dataUrl));

    // Assume server is running after a short delay if no error
    const t = setTimeout(() => setServerStatus(s => s === 'starting' ? 'running' : s), 3000);

    return () => {
      window.api?.offServerLog?.();
      window.api?.offLocalPreview?.();
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    // Read the persisted preference to reflect what server.py was actually
    // launched with (electron.js passes it as --control-allowed at spawn).
    window.api?.get('controlAllowed').then(v => {
      if (v !== undefined) setControlAllowedState(v !== false);
    });
  }, []);

  const toggleControlAllowed = async () => {
    const next = !controlAllowed;
    setControlAllowedState(next); // optimistic
    const res = await window.api?.setControlAllowed(next);
    if (!res?.ok) {
      setControlAllowedState(!next); // revert on failure
    }
  };

  const copyIP = (ip) => {
    navigator.clipboard.writeText(ip);
    setCopied(ip);
    setTimeout(() => setCopied(''), 2000);
  };

  const getLogClass = (line) => {
    if (line.includes('[ERR]') || line.includes('Error') || line.includes('Failed')) return 'log-line-err';
    if (line.includes('Warning') || line.includes('warn')) return 'log-line-warn';
    if (line.includes('connected') || line.includes('Waiting') || line.includes('Starting') || line.includes('listening')) return 'log-line-ok';
    return 'log-line-info';
  };

  return (
    <div className="panel">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <button className="back-btn" onClick={() => setPage('home')}>←</button>
          <div>
            <div className="sidebar-title">Server Mode</div>
            <div className="sidebar-sub">HOSTING</div>
          </div>
        </div>

        {/* Status */}
        <div className={`status-badge ${serverStatus === 'running' ? 'active' : serverStatus === 'error' ? 'error' : 'connecting'}`}>
          <div className="status-dot" />
          {serverStatus === 'running' ? 'Server Running'
            : serverStatus === 'error' ? 'Server Error'
            : 'Starting Server...'}
        </div>

        {/* Remote control permission — gates whether connecting clients can
            send input at all; server.py enforces this, not just the UI. */}
        <div className="box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div className="box-title" style={{ marginBottom: 2 }}>Allow Remote Control</div>
              <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
                {controlAllowed ? 'Viewers can control this device' : 'View-only — input is blocked'}
              </div>
            </div>
            <button
              onClick={toggleControlAllowed}
              style={{
                width: 44, height: 24, borderRadius: 12, border: '1px solid var(--border)',
                background: controlAllowed ? 'var(--accent)' : 'var(--bg-3)',
                position: 'relative', cursor: 'pointer', flexShrink: 0, padding: 0,
              }}
              title={controlAllowed ? 'Click to disable remote control' : 'Click to enable remote control'}
            >
              <span style={{
                position: 'absolute', top: 2, left: controlAllowed ? 22 : 2,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left 0.15s ease',
              }} />
            </button>
          </div>
        </div>

        {/* Network Info */}
        {networkInfo && (
          <div className="box">
            <div className="box-title">Your Network</div>
            <div className="session-info">
              <div className="info-row">
                <span className="info-key">HOSTNAME</span>
                <span className="info-val">{networkInfo.hostname}</span>
              </div>
              <div className="info-row">
                <span className="info-key">SCREEN PORT</span>
                <span className="info-val green">8080</span>
              </div>
              <div className="info-row">
                <span className="info-key">CONTROL PORT</span>
                <span className="info-val green">9999</span>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="box-title" style={{ marginBottom: 8 }}>Share This IP</div>
              {networkInfo.ips.map(ip => (
                <div key={ip} className="info-row">
                  <span className="info-val">{ip}</span>
                  <button
                    className={`copy-tag ${copied === ip ? 'ok' : ''}`}
                    onClick={() => copyIP(ip)}
                  >
                    {copied === ip ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              ))}
              {!networkInfo.ips.length && (
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  No network detected
                </span>
              )}
            </div>
          </div>
        )}

        {/* How to connect */}
        <div className="box">
          <div className="box-title">How Remote Users Connect</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', lineHeight: 1.9 }}>
            <div>1. Open TouchBridge → Client Mode</div>
            <div>2. Enter your IP address above</div>
            <div>3. Ports: Screen=8080, Control=9999</div>
            <div>4. Click Connect</div>
          </div>
        </div>

        <div className="mt-auto">
          <button className="btn btn-danger" onClick={() => setPage('home')}>⬡ Stop Server</button>
        </div>
      </div>

      {/* Main */}
      <div className="panel-main">
        <div className="view-area" style={{ flex: 1, position: 'relative' }}>
          {preview ? (
            <>
              <img
                className="screen-img"
                src={preview}
                alt="What remote viewers currently see"
                draggable={false}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
              <div style={{
                position: 'absolute', top: 8, right: 8,
                background: 'color-mix(in srgb, var(--accent-2) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--accent-2) 30%, transparent)',
                borderRadius: 7, padding: '4px 11px',
                fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-2)',
                letterSpacing: '0.1em',
              }}>
                LOCAL PREVIEW
              </div>
            </>
          ) : (
            <div className="view-empty">
              <div className="big-icon"
                style={{ animation: serverStatus === 'running' ? 'none' : 'blink 1.5s infinite' }}>
                {serverStatus === 'running' ? '📡' : '⏳'}
              </div>
              <p>
                {serverStatus === 'running'
                  ? 'Capturing screen — waiting for a remote client to connect...'
                  : 'Starting Python server...'}
              </p>
              {serverStatus === 'running' && (
                <p style={{ color: 'var(--accent-2)', marginTop: 8 }}>
                  {networkInfo?.ips?.[0] ? `ws://${networkInfo.ips[0]}` : 'Server ready'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Log console */}
        <div style={{ padding: '12px 16px', background: 'var(--bg-1)', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', letterSpacing: '0.12em', marginBottom: 6 }}>
            SERVER LOG
          </div>
          <div className="log-console" ref={logRef}>
            {logs.length === 0 && (
              <span style={{ color: 'var(--text-3)' }}>Waiting for output...</span>
            )}
            {logs.map((line, i) => (
              <div key={i} className={getLogClass(line)}>{line}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
