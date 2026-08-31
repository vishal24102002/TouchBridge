import React, { useEffect, useState, useRef } from 'react';
import { useNav } from '../App';

export default function ServerPage() {
  const { setPage, networkInfo } = useNav();
  const [logs, setLogs] = useState([]);
  const [serverStatus, setServerStatus] = useState('starting'); // starting | running | error
  const [copied, setCopied] = useState('');
  const [preview, setPreview] = useState(null); // data URL from the local capture window
  const [clients, setClients] = useState([]); // connected control-channel devices, pushed live from server.py
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

    // Live list of devices holding a control-channel connection, pushed
    // by electron.js whenever server.py reports a change (connect,
    // disconnect, grant, revoke) — see server.py's ControlSession.
    window.api?.onControlClientsUpdated((list) => setClients(list || []));

    // Assume server is running after a short delay if no error
    const t = setTimeout(() => setServerStatus(s => s === 'starting' ? 'running' : s), 3000);

    return () => {
      window.api?.offServerLog?.();
      window.api?.offLocalPreview?.();
      window.api?.offControlClientsUpdated?.();
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // Grant one connected device exclusive control — server.py automatically
  // revokes whoever had it before, and the updated list arrives via the
  // 'control-clients-updated' push, so there's no local state to set here.
  const grantControlTo = async (clientId) => {
    await window.api?.grantControl(clientId);
  };

  // Take control away from whoever currently has it, leaving every
  // connected device view-only.
  const revokeControl = async () => {
    await window.api?.revokeControl();
  };

  const formatDuration = (connectedAt) => {
    const secs = Math.max(0, Math.floor(Date.now() / 1000 - connectedAt));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
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
          {/* Back now stops the host session — same effect as "Stop Server" —
              so leaving this screen never leaves screen sharing running
              invisibly in the background. */}
          <button className="back-btn" onClick={async () => { await window.api?.stopServer(); setPage('home'); }}>←</button>
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

        {/* Connected devices — remote control is granted per device, one
            at a time, instead of a single host-wide switch. A device
            shows up here as soon as it opens a control connection (i.e.
            clicks "Enable Control" on its end); granting one automatically
            revokes whoever had it before — server.py enforces this, not
            just the UI. */}
        <div className="box">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="box-title" style={{ marginBottom: 0 }}>Connected Devices</div>
            {clients.some(c => c.controlling) && (
              <button
                className="btn btn-ghost"
                style={{ width: 'auto', padding: '3px 10px', fontSize: 10 }}
                onClick={revokeControl}
              >
                Revoke All
              </button>
            )}
          </div>

          {clients.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              No devices connected
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {clients.map(c => (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 'var(--r)',
                  border: `1px solid ${c.controlling ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                <div>
                  <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>
                    {c.addr}
                  </div>
                  <div style={{
                    fontSize: 10, fontFamily: 'var(--font-mono)',
                    color: c.controlling ? 'var(--accent-2)' : 'var(--text-3)',
                  }}>
                    {c.controlling ? '● In control' : 'View only'} · {formatDuration(c.connectedAt)}
                  </div>
                </div>
                {c.controlling ? (
                  <button
                    className="btn btn-danger"
                    style={{ width: 'auto', padding: '5px 12px', fontSize: 11 }}
                    onClick={revokeControl}
                  >
                    Revoke
                  </button>
                ) : (
                  <button
                    className="btn btn-success"
                    style={{ width: 'auto', padding: '5px 12px', fontSize: 11 }}
                    onClick={() => grantControlTo(c.id)}
                  >
                    Grant
                  </button>
                )}
              </div>
            ))}
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
          <button className="btn btn-danger" onClick={async () => { await window.api?.stopServer(); setPage('home'); }}>⬡ Stop Server</button>
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