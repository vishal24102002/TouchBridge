import React, { useEffect, useState, useRef } from 'react';
import { useNav } from '../App';

export default function ServerPage() {
  const { setPage, networkInfo } = useNav();
  const [logs, setLogs] = useState([]);
  const [serverStatus, setServerStatus] = useState('starting'); // starting | running | error
  const [copied, setCopied] = useState('');
  const [preview, setPreview] = useState(null); // data URL from the local capture window
  const [clients, setClients] = useState([]); // connected control-channel devices, pushed live from server.py
  const [pendingRequests, setPendingRequests] = useState([]); // in-flight pairing requests awaiting Accept/Deny
  const [deviceId, setDeviceId] = useState('');
  const [hostPassword, setHostPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const logRef = useRef(null);

  // Chat — real text messages and file attachments, relayed by server.py
  // over the already-encrypted, already-authenticated control channel to
  // every connected device (subject to the on/off toggle below). Files
  // travel as base64 over that same channel (see server.py's "file:"
  // handling) rather than a separate binary transfer protocol — fine for
  // the kind of small attachments chat is meant for, capped server-side.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatEnabled, setChatEnabledState] = useState(true);
  const [messages, setMessages] = useState([]); // { id, from, text?, fileName?, savedPath?, time }
  const [draft, setDraft] = useState('');
  const [fileSending, setFileSending] = useState(false);
  const chatScrollRef = useRef(null);

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

    // Live list of in-flight pairing requests (password verified, waiting
    // on this host to Accept/Deny) — see server.py's PairingManager.
    window.api?.onPendingRequestsUpdated((list) => setPendingRequests(list || []));

    // Incoming chat messages from any connected device — server.py has
    // already broadcast them to everyone else; this is just how the host's
    // own panel finds out. Errors (e.g. a message the host tried to send
    // while chat was off) also come through here with an `error` field.
    window.api?.onChatMessage((msg) => {
      if (msg?.error) return; // host-side send errors are surfaced by sendChatMessage's own return value instead
      setMessages(prev => [...prev, {
        id: `${msg.time}-${Math.random()}`, from: msg.from,
        text: msg.text, fileName: msg.fileName, savedPath: msg.savedPath, time: msg.time,
      }]);
    });

    // The device ID/password are read straight from disk (see
    // electron.js's loadOrCreateDeviceIdentity) rather than round-tripped
    // through Python's admin port, so this resolves immediately — no
    // need to wait for the server to finish starting, and no retry loop.
    window.api?.getDeviceId().then(res => {
      if (res?.ok) {
        setDeviceId(res.id);
        setHostPassword(res.password);
      }
    });

    // Assume server is running after a short delay if no error
    const t = setTimeout(() => setServerStatus(s => s === 'starting' ? 'running' : s), 3000);

    return () => {
      window.api?.offServerLog?.();
      window.api?.offLocalPreview?.();
      window.api?.offControlClientsUpdated?.();
      window.api?.offPendingRequestsUpdated?.();
      window.api?.offChatMessage?.();
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages]);

  const sendChatMessage = async () => {
    const text = draft.trim();
    if (!text || !chatEnabled) return;
    setDraft('');
    setMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'Host', text, time: Date.now() }]);
    const res = await window.api?.sendHostChatMessage(text);
    if (!res?.ok) {
      setMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'System', text: `Message not delivered: ${res?.error || 'unknown error'}`, time: Date.now() }]);
    }
  };

  const toggleChatEnabled = async (next) => {
    setChatEnabledState(next); // optimistic
    const res = await window.api?.setChatEnabled(next);
    if (!res?.ok) setChatEnabledState(!next); // revert on failure
  };

  const sendChatFile = async () => {
    if (!chatEnabled || fileSending) return;
    setFileSending(true);
    const res = await window.api?.sendHostFile();
    setFileSending(false);
    if (res?.canceled) return;
    if (res?.ok) {
      setMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'Host', fileName: res.fileName, time: Date.now() }]);
    } else {
      setMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'System', text: `File not sent: ${res?.error || 'unknown error'}`, time: Date.now() }]);
    }
  };

  const formatChatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

  // Approve/deny an incoming pairing request — server.py is blocked
  // waiting on this decision (see PairingManager.request), so the
  // requester gets an immediate token or denial once we respond.
  const acceptRequest = async (id) => { await window.api?.acceptRequest(id); };
  const denyRequest   = async (id) => { await window.api?.denyRequest(id); };

  const regenPassword = async () => {
    const res = await window.api?.regenHostPassword();
    if (res?.ok) setHostPassword(res.password);
  };

  const copyText = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
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
        {/* <div className={`status-badge ${serverStatus === 'running' ? 'active' : serverStatus === 'error' ? 'error' : 'connecting'}`}>
          <div className="status-dot" />
          {serverStatus === 'running' ? 'Server Running'
            : serverStatus === 'error' ? 'Server Error'
            : 'Starting Server...'}
        </div> */}

        {/* Pending pairing requests — a device that passed the password
            check is waiting right here for an explicit decision; nothing
            is granted until you click Accept. */}
        {pendingRequests.length > 0 && (
          <div className="box" style={{ border: '1px solid var(--warn)' }}>
            <div className="box-title" style={{ color: 'var(--warn)' }}>
              Connection Requests ({pendingRequests.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pendingRequests.map(r => (
                <div key={r.id} style={{
                  padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 'var(--r)',
                  border: '1px solid var(--border)',
                }}>
                  <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-0)' }}>
                    {r.label}
                  </div>
                  <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginBottom: 8 }}>
                    {r.addr} · password verified — awaiting your decision
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-success"
                      style={{ flex: 1, padding: '5px 0', fontSize: 11 }}
                      onClick={() => acceptRequest(r.id)}
                    >
                      Accept
                    </button>
                    <button
                      className="btn btn-danger"
                      style={{ flex: 1, padding: '5px 0', fontSize: 11 }}
                      onClick={() => denyRequest(r.id)}
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connection credentials — how a remote device finds and pairs
            with this host: either its ID (resolved over the LAN) or a
            direct IP, plus the password every connection must supply
            before it even shows up above as a pending request. */}
        <div className="box">
          <div className="box-title">Connection Info</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginBottom: 4 }}>
                DEVICE ID {deviceId ? '' : '(starting…)'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{
                  flex: 1, fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: '0.05em',
                  color: 'var(--accent)', background: 'var(--bg-2)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r)', padding: '6px 10px',
                }}>
                  {deviceId || '—'}
                </div>
                {deviceId && (
                  <button className="copy-tag" onClick={() => copyText(deviceId, 'id')}>
                    {copied === 'id' ? '✓ Copied' : 'Copy'}
                  </button>
                )}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginBottom: 4 }}>
                PASSWORD
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{
                  flex: 1, fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: '0.05em',
                  color: 'var(--accent-2)', background: 'var(--bg-2)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r)', padding: '6px 10px',
                }}>
                  {hostPassword ? (showPassword ? hostPassword : '•'.repeat(hostPassword.length)) : '—'}
                </div>
                <button className="copy-tag" onClick={() => setShowPassword(s => !s)}>
                  {showPassword ? 'Hide' : 'Show'}
                </button>
                {hostPassword && (
                  <button className="copy-tag" onClick={() => copyText(hostPassword, 'pw')}>
                    {copied === 'pw' ? '✓ Copied' : 'Copy'}
                  </button>
                )}
              </div>
              <button
                className="btn btn-ghost"
                style={{ width: 'auto', padding: '4px 10px', fontSize: 10, marginTop: 6 }}
                onClick={regenPassword}
              >
                ⟳ Generate New Password
              </button>
            </div>

            <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', lineHeight: 1.6 }}>
              Every connection — by ID or by IP — needs this password, then your
              explicit Accept above. Connections are TLS-encrypted end to end.
              ID lookup only works on the same local network. Want a password
              that doesn't change? Set a permanent one from Settings.
            </div>

            {networkInfo && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
                  Your Network
                </div>
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

                <div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', letterSpacing: '0.1em', marginBottom: 6, textTransform: 'uppercase' }}>
                    Share This IP
                  </div>
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
          </div>
        </div>

        {/* Connected devices — remote control is granted per device, one
            at a time, instead of a single host-wide switch. A device
            shows up here as soon as it opens a control connection (i.e.
            clicks "Enable Control" on its end); granting one automatically
            revokes whoever had it before — server.py enforces this, not
            just the UI. */}
        <div className="box box-scroll">
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

          <div className="box-scroll-body">
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
        </div>

        {/* How to connect */}
        {/* <div className="box">
          <div className="box-title">How Remote Users Connect</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', lineHeight: 1.9 }}>
            <div>1. Open TouchBridge → Client Mode</div>
            <div>2. Enter your Device ID (same network) or IP</div>
            <div>3. Enter the password above</div>
            <div>4. Wait for you to Accept the request</div>
          </div>
        </div> */}

        <div className="mt-auto">
          <button className="btn btn-danger" onClick={async () => { await window.api?.stopServer(); setPage('home'); }}>⬡ Stop Server</button>
        </div>
      </div>

      {/* Main */}
      <div className="panel-main">
        {/* Toolbar — Chat toggle on the right, status pill (same style/
            size as the sidebar's) immediately to its right */}
        <div className="main-toolbar">
          <button
            className={`btn btn-ghost chat-toggle-btn ${chatOpen ? 'active' : ''}`}
            onClick={() => setChatOpen(o => !o)}
          >
            💬 Chat
          </button>
          <div className={`status-badge ${serverStatus === 'running' ? 'active' : serverStatus === 'error' ? 'error' : 'connecting'}`}>
            <div className="status-dot" />
            {serverStatus === 'running' ? 'Server Running'
              : serverStatus === 'error' ? 'Server Error'
              : 'Starting Server...'}
          </div>
        </div>

        <div className="main-content-row">
          <div className="main-content-col">
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
                  {/* <div style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'color-mix(in srgb, var(--accent-2) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-2) 30%, transparent)',
                    borderRadius: 7, padding: '4px 11px',
                    fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-2)',
                    letterSpacing: '0.1em',
                  }}>
                    LOCAL PREVIEW
                  </div> */}
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

          {/* Chat panel — mirrors the sidebar's frame, anchored on the
              right. Hidden entirely when chatOpen is false. */}
          {chatOpen && (
            <div className="chat-panel">
              <div className="chat-header">
                <div>
                  <div className="sidebar-title" style={{ fontSize: 15 }}>Chat</div>
                  <div className="sidebar-sub">{chatEnabled ? 'ENABLED FOR THIS SESSION' : 'DISABLED BY HOST'}</div>
                </div>
                <label className="switch" title={chatEnabled ? 'Disable chat' : 'Enable chat'}>
                  <input
                    type="checkbox"
                    checked={chatEnabled}
                    onChange={(e) => toggleChatEnabled(e.target.checked)}
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              {chatEnabled ? (
                <>
                  <div className="chat-messages" ref={chatScrollRef}>
                    {messages.length === 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', textAlign: 'center', marginTop: 20 }}>
                        No messages yet
                      </div>
                    )}
                    {messages.map(m => (
                      <div key={m.id} className={`chat-message ${m.from === 'Host' ? 'from-host' : 'from-remote'}`}>
                        {m.from && m.from !== 'Host' && (
                          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginBottom: 2 }}>
                            {m.from}
                          </div>
                        )}
                        {m.fileName ? (
                          <div className="chat-file-chip">
                            📎 {m.fileName}
                            {m.savedPath && (
                              <div style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                                Saved to Downloads/TouchBridge
                              </div>
                            )}
                          </div>
                        ) : (
                          <div>{m.text}</div>
                        )}
                        <div className="chat-message-time">{formatChatTime(m.time)}</div>
                      </div>
                    ))}
                  </div>

                  <div className="chat-input-row">
                    <button
                      className="btn btn-ghost chat-attach-btn"
                      title="Send a file"
                      disabled={fileSending}
                      onClick={sendChatFile}
                    >
                      {fileSending ? '…' : '📎'}
                    </button>
                    <input
                      className="field-input chat-text-input"
                      placeholder="Type a message…"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                    />
                    <button className="btn btn-primary chat-send-btn" title="Send message" onClick={sendChatMessage}>
                      ➤
                    </button>
                  </div>
                </>
              ) : (
                <div className="chat-disabled-note">
                  Chat is turned off for this session.<br />Flip the switch above to let devices message you.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}