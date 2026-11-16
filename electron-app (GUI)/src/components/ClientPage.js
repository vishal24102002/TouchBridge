import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNav } from '../App';
import { H264Player } from '../h264Player';
import { AudioPlayer } from '../audioPlayer';

// All commands supported by server.py
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
  { label: 'Tab', cmd: 'shortcut:tab' },
  { label: 'Caps Lock', cmd: 'shortcut:caps_lock' },
  { label: 'Delete', cmd: 'shortcut:delete' },
  { label: 'Insert', cmd: 'shortcut:insert' },
  { label: 'Home', cmd: 'shortcut:home' },
  { label: 'End', cmd: 'shortcut:end' },
  { label: 'Print Scrn', cmd: 'shortcut:print_screen' },
  { label: 'Alt+Tab', cmd: 'shortcut:alt_tab' },
  { label: 'Alt+F4', cmd: 'shortcut:alt_f4' },
  { label: 'Win+D', cmd: 'shortcut:win_d' },
  { label: 'Super', cmd: 'shortcut:super' },
  // Row 4 - Function keys
  { label: 'F1', cmd: 'shortcut:f1' }, { label: 'F2', cmd: 'shortcut:f2' },
  { label: 'F3', cmd: 'shortcut:f3' }, { label: 'F4', cmd: 'shortcut:f4' },
  { label: 'F5', cmd: 'shortcut:f5' }, { label: 'F6', cmd: 'shortcut:f6' },
  { label: 'F7', cmd: 'shortcut:f7' }, { label: 'F8', cmd: 'shortcut:f8' },
  { label: 'F9', cmd: 'shortcut:f9' }, { label: 'F10', cmd: 'shortcut:f10' },
  { label: 'F11', cmd: 'shortcut:f11' }, { label: 'F12', cmd: 'shortcut:f12' },
  // Row 5 - Apps
  { label: '🌐 Browser', cmd: 'open_browser' },
  { label: '📁 Folder', cmd: 'custom:open_folder' },
  { label: '🖥 Terminal', cmd: 'open_terminal' },
  { label: '🎵 Play/Pause', cmd: 'media_play_pause' },
  { label: '🔊 Vol+', cmd: 'volume_up' },
  { label: '🔇 Mute', cmd: 'volume_mute' },
];

// Every connection has to authenticate with server.py's pairing port
// before it gets a session token — this default matches server.py's
// --pair-port default (9997) and isn't currently exposed as a Settings
// field, unlike screen/control ports.
const PAIR_PORT = 9997;

// Shows one frame in the <img> and acks the main process once it is on
// screen. The previous frame's object URL is released after the new one loads.
function showFrame(img, url, onShown) {
  const prev = img.dataset.url;
  img.onload = () => {
    if (prev) URL.revokeObjectURL(prev);
    if (onShown) onShown();
    window.api?.screenFrameDone();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    window.api?.screenFrameDone();
  };
  img.dataset.url = url;
  img.src = url;
}

export default function ClientPage() {
  const { setPage } = useNav();

  // Connection form — either resolve a Device ID to an IP over the LAN,
  // or connect straight to an IP the user already has. Either way, a
  // password is required and the host must explicitly accept before
  // anything is shared.
  const [connectMode, setConnectMode] = useState('ip'); // 'ip' | 'id'
  const [host, setHost] = useState('');
  const [deviceIdInput, setDeviceIdInput] = useState('');
  const [password, setPassword] = useState('');
  const [screenPort, setScreenPort] = useState('8080');
  const [controlPort, setControlPort] = useState('9999');

  // State
  const [phase, setPhase] = useState('form'); // form | connecting | connected | error
  const [pairStatus, setPairStatus] = useState(''); // shown while phase === 'connecting'
  const [sessionToken, setSessionToken] = useState(null); // issued after the host Accepts
  const [errorMsg, setErrorMsg] = useState('');
  const [hasFrame, setHasFrame] = useState(false); // frames are painted straight into the <img>, not via React state
  const [controlEnabled, setControlEnabled] = useState(false);
  const [controlPending, setControlPending] = useState(false); // connected, waiting on host to grant
  const [isCapturing, setIsCapturing] = useState(false);
  const [fps, setFps] = useState(0);
  const [typeText, setTypeText] = useState('');
  const [lastCmdStatus, setLastCmdStatus] = useState('');
  const [zoom, setZoom] = useState(1);

  // Chat — only usable at all if the host currently has it turned on
  // (pushed via CHAT_STATE right after the control channel connects, and
  // again any time the host flips it mid-session). No button/panel is
  // shown when chatAllowed is false, per how this is meant to work: chat
  // is something the host opts the session into, not something a client
  // can force open.
  const [chatAllowed, setChatAllowed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatTarget, setChatTarget] = useState('all'); // who my messages go to: 'all' | 'host'
  const [fileSending, setFileSending] = useState(false);
  const chatScrollRef = useRef(null);

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 3;
  const zoomIn = () => setZoom(z => Math.min(ZOOM_MAX, +(z + 0.25).toFixed(2)));
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - 0.25).toFixed(2)));
  const zoomReset = () => setZoom(1);

  const imgRef = useRef(null);
  // H.264 frames are decoded by H264Player into a <canvas>; JPEG/PNG frames go
  // into the <img>. The host can switch codec mid-session, so the view follows
  // whatever kind of frame arrives (viewMode / viewModeRef).
  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const audioRef = useRef(null);          // AudioPlayer for the host's shared audio
  const audioMutedRef = useRef(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false); // the host is actually sending audio
  const pendingVideoRef = useRef([]); // H.264 frames that arrived before the <canvas> mounted
  const viewModeRef = useRef('image');
  const [viewMode, setViewMode] = useState('image'); // 'image' | 'video'
  const [videoNote, setVideoNote] = useState(null);
  const pendingUrlRef = useRef(null);
  const capturingRef = useRef(false);
  const streamArgsRef = useRef(null); // { host, port, token } for auto-retry / resume
  const fpsCounter = useRef(0);
  const fpsTimer = useRef(null);


  // Load saved host
  useEffect(() => {
    window.api?.get('lastHost').then(h => { if (h) setHost(h); });
    window.api?.get('lastScreenPort').then(p => { if (p) setScreenPort(p); });
    window.api?.get('lastControlPort').then(p => { if (p) setControlPort(p); });
    window.api?.get('lastConnectMode').then(m => { if (m) setConnectMode(m); });
    window.api?.get('lastDeviceId').then(id => { if (id) setDeviceIdInput(id); });
    return () => stopCapture();
  }, []);

  // Control is now granted per device by the host, one at a time — it can
  // change mid-session (host grants someone else, or revokes outright), so
  // this listens for live pushes rather than assuming whatever the initial
  // handshake said still holds.
  useEffect(() => {
    window.api?.onControlStatus((status) => {
      setControlPending(false);
      setControlEnabled(!!status.granted);
      if (status.disconnected) {
        setLastCmdStatus('Control connection closed');
      } else {
        setLastCmdStatus(status.granted ? 'Control granted by host' : 'Control revoked by host');
      }
    });
    return () => window.api?.offControlStatus?.();
  }, []);

  // Chat availability and incoming messages both arrive over the same
  // control channel connection established in connect() below — CHAT_STATE
  // right after connecting (and again on change), CHAT: messages whenever
  // the host or another device sends one.
  useEffect(() => {
    window.api?.onChatState((state) => {
      setChatAllowed(!!state.enabled);
      if (!state.enabled) setChatOpen(false); // host turned it off — don't leave a dead panel open
    });
    window.api?.onChatMessage((msg) => {
      if (msg?.error) {
        setChatMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'System', text: `Message not delivered (${msg.error})`, time: msg.time }]);
        return;
      }
      setChatMessages(prev => [...prev, {
        id: `${msg.time}-${Math.random()}`, from: msg.from,
        text: msg.text, fileName: msg.fileName, savedPath: msg.savedPath, time: msg.time,
      }]);
    });
    return () => {
      window.api?.offChatState?.();
      window.api?.offChatMessage?.();
    };
  }, []);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatMessages]);

  const connect = async () => {
    setErrorMsg('');

    if (connectMode === 'id' && !deviceIdInput.trim()) { setErrorMsg('Enter a Device ID'); return; }
    if (connectMode === 'ip' && !host.trim()) { setErrorMsg('Enter a host IP address'); return; }
    if (!password.trim()) { setErrorMsg('Enter the host password'); return; }

    setPhase('connecting');

    let targetHost = host.trim();
    if (connectMode === 'id') {
      setPairStatus('Looking up device on the local network...');
      const resolved = await window.api?.resolveId(deviceIdInput.trim());
      if (!resolved?.ok) {
        setErrorMsg(resolved?.error || 'Could not find that device on this network');
        setPhase('form');
        return;
      }
      targetHost = resolved.ip;
      setHost(resolved.ip);
    }

    // Save prefs
    window.api?.set('lastHost', targetHost);
    window.api?.set('lastScreenPort', screenPort);
    window.api?.set('lastControlPort', controlPort);
    window.api?.set('lastConnectMode', connectMode);
    if (connectMode === 'id') window.api?.set('lastDeviceId', deviceIdInput.trim());

    // Pairing: password check + host acceptance. This call stays pending
    // for as long as the host takes to Accept/Deny (server.py enforces a
    // timeout), so don't treat a long wait here as a failure.
    setPairStatus('Waiting for the host to accept your connection request...');
    const pairRes = await window.api?.pairConnect(targetHost, PAIR_PORT, password, undefined);

    if (!pairRes?.ok) {
      setErrorMsg(pairRes?.error || `Could not reach ${targetHost}`);
      setPhase('form');
      return;
    }
    if (!pairRes.accepted) {
      setErrorMsg(
        pairRes.reason === 'bad_password' ? 'Incorrect password'
        : pairRes.reason === 'host_declined_or_timeout' ? 'The host declined the request (or it timed out)'
        : 'Connection was not accepted'
      );
      setPhase('form');
      return;
    }

    const token = pairRes.token;
    setSessionToken(token);

    // Open the persistent screen stream, authenticated with the session
    // token pairing just issued. The first frame proves the host is reachable.
    const started = await startStream(targetHost, parseInt(screenPort), token);
    if (!started.ok) {
      setErrorMsg(`Cannot reach ${targetHost}:${screenPort} — is the server running?`);
      setPhase('form');
      return;
    }

    setPhase('connected');

    // Open the control channel right away, view-only until the host
    // grants otherwise — this is also what carries chat, so chat works
    // immediately without the user having to click "Enable Control" (that
    // button now mostly just reflects/re-requests the same connection).
    openControlChannel(targetHost, token);
  };

  // Frames arrive over ONE persistent connection (see electron.js
  // 'screen-stream-start'); the main process only ever hands us the newest
  // frame and waits for screenFrameDone() before sending the next, so a slow
  // UI drops frames instead of falling behind.
  const startStream = async (h, port, token) => {
    streamArgsRef.current = { host: h, port, token };
    const res = await window.api?.screenStreamStart(h, port, token);
    if (res?.ok) {
      capturingRef.current = true;
      setIsCapturing(true);
      fpsCounter.current = 0;
      clearInterval(fpsTimer.current);
      fpsTimer.current = setInterval(() => {
        setFps(fpsCounter.current);
        fpsCounter.current = 0;
      }, 1000);
    }
    return res || { ok: false };
  };

  const startCapture = () => {
    const a = streamArgsRef.current;
    if (a) startStream(a.host, a.port, a.token);
  };

  const stopCapture = () => {
    capturingRef.current = false;
    clearInterval(fpsTimer.current);
    window.api?.screenStreamStop();
    setIsCapturing(false);
  };

  // Paint a frame straight into the <img> / <canvas> (no React re-render per frame).
  useEffect(() => {
    if (!window.api?.onScreenFrame) return undefined;
    const offFrame = window.api.onScreenFrame((ab, mime) => {
      if (mime === 'video/h264') {
        if (viewModeRef.current !== 'video') { viewModeRef.current = 'video'; setViewMode('video'); }
        const player = playerRef.current;
        if (player) {
          player.push(ab);
        } else { // <canvas> not mounted yet: queue (capped) and let the ref callback flush
          const q = pendingVideoRef.current;
          q.push(ab);
          if (q.length > 300) q.shift();
          setHasFrame(true);
        }
        return;
      }
      if (viewModeRef.current !== 'image') { viewModeRef.current = 'image'; setViewMode('image'); }
      const url = URL.createObjectURL(new Blob([ab], { type: mime }));
      const img = imgRef.current;
      if (!img) { // first frame, <img> not mounted yet: the ref callback shows it
        pendingUrlRef.current = url;
        setHasFrame(true);
        return;
      }
      showFrame(img, url, () => { fpsCounter.current++; });
    });
    const offEnded = window.api.onScreenStreamEnded(async () => {
      if (!capturingRef.current) return;
      // One quiet retry for a brief Wi-Fi hiccup, then fall back to Resume.
      await new Promise(r => setTimeout(r, 500));
      const a = streamArgsRef.current;
      const res = a && capturingRef.current ? await window.api.screenStreamStart(a.host, a.port, a.token) : null;
      if (!res?.ok) stopCapture();
    });
    return () => { offFrame?.(); offEnded?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Host audio (Settings → Audio on the host turns it on). "Play host audio"
  // in this device's Settings decides whether it starts muted; the speaker
  // button in the toolbar toggles it for this session.
  useEffect(() => {
    let alive = true;
    window.api?.get?.('playRemoteAudio').then((v) => {
      if (alive && v === false) { audioMutedRef.current = true; setAudioMuted(true); }
    }).catch(() => {});
    let announced = false;
    const off = window.api?.onScreenAudio?.((ab) => {
      if (!audioRef.current) {
        audioRef.current = new AudioPlayer();
        audioRef.current.setMuted(audioMutedRef.current);
      }
      if (!announced) { announced = true; setHasAudio(true); }
      audioRef.current.push(ab);
    });
    return () => {
      alive = false;
      off?.();
      audioRef.current?.close();
      audioRef.current = null;
    };
  }, []);

  const toggleAudioMute = () => {
    const next = !audioMutedRef.current;
    audioMutedRef.current = next;
    setAudioMuted(next);
    audioRef.current?.setMuted(next);
    if (!next) audioRef.current?.resume();
  };

  const setImgEl = useCallback((el) => {
    imgRef.current = el;
    if (el && pendingUrlRef.current) {
      const u = pendingUrlRef.current;
      pendingUrlRef.current = null;
      showFrame(el, u);
    }
  }, []);

  const setCanvasEl = useCallback((el) => {
    canvasRef.current = el;
    if (!el) {
      playerRef.current?.close();
      playerRef.current = null;
      return;
    }
    if (!playerRef.current) {
      playerRef.current = new H264Player(el, {
        onFrame: () => { fpsCounter.current++; },
        onStatus: (msg) => setVideoNote(msg),
      });
    }
    const queued = pendingVideoRef.current;
    pendingVideoRef.current = [];
    queued.forEach(ab => playerRef.current.push(ab));
  }, []);

  const disconnect = async () => {
    stopCapture();
    pendingVideoRef.current = [];
    viewModeRef.current = 'image';
    setViewMode('image');
    setVideoNote(null);
    if (imgRef.current?.dataset.url) URL.revokeObjectURL(imgRef.current.dataset.url);
    await window.api?.controlDisconnect();
    setPhase('form');
    setHasFrame(false);
    setControlEnabled(false);
    setSessionToken(null);
    setChatAllowed(false);
    setChatOpen(false);
    setChatMessages([]);
  };

  // Opens the control channel (view-only by default; the host grants
  // actual mouse/keyboard control separately) — takes host/token as
  // explicit params rather than reading state, because connect() needs to
  // call this before `host`/`sessionToken` state updates have landed yet
  // (React state set earlier in the same async function isn't readable
  // via closure until the next render). The "Enable Control" button below
  // just calls this with current state, where that's not a concern.
  const openControlChannel = async (targetHost, token) => {
    setControlPending(true);
    const res = await window.api?.controlConnect(targetHost, parseInt(controlPort), token);

    if (!res?.ok) {
      setControlPending(false);
      setControlEnabled(false);
      setLastCmdStatus(`Control error: ${res?.error}`);
      return;
    }
    if (res.capable === false) {
      // Host has no input capability at all (see server.py NOCAP) — no
      // point staying "pending", there's nothing to wait for.
      setControlPending(false);
      setControlEnabled(false);
      setLastCmdStatus(res.description || 'Host has no input capability');
      return;
    }
    if (res.granted) {
      setControlPending(false);
      setControlEnabled(true);
      setLastCmdStatus('Control granted');
    } else {
      // Connected, but the host hasn't granted this device control yet —
      // stay pending until a 'control-status' push says otherwise. Chat
      // (if the host has it on) already works in this state.
      setControlPending(true);
      setControlEnabled(false);
      setLastCmdStatus('Connected — waiting for host to grant control');
    }
  };

  const enableControl = () => openControlChannel(host.trim(), sessionToken);

  const disableControl = async () => {
    // Note: this closes the whole control-channel socket, not just the
    // control grant — since chat rides the same connection, disabling
    // control also (temporarily) closes chat. Clicking "Enable Control"
    // again reopens both.
    await window.api?.controlDisconnect();
    setControlEnabled(false);
    setControlPending(false);
    setChatAllowed(false);
    setChatOpen(false);
    setLastCmdStatus('Control disconnected');
  };

  const sendClientChatMessage = async () => {
    const text = chatDraft.trim();
    if (!text || !chatAllowed) return;
    setChatDraft('');
    setChatMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'You', text, time: Date.now(), scope: chatTarget }]);
    // chat: = everyone, chat-host: = the host only (server.py never relays it)
    const res = await window.api?.controlSend(`${chatTarget === 'host' ? 'chat-host' : 'chat'}:${text}`);
    if (!res?.ok) {
      setChatMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'System', text: `Message not sent: ${res?.error || 'not connected'}`, time: Date.now() }]);
    }
  };

  const sendClientFile = async () => {
    if (!chatAllowed || fileSending) return;
    setFileSending(true);
    const res = await window.api?.sendClientFile(chatTarget);
    setFileSending(false);
    if (res?.canceled) return;
    if (res?.ok) {
      setChatMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'You', fileName: res.fileName, time: Date.now(), scope: chatTarget }]);
    } else {
      setChatMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, from: 'System', text: `File not sent: ${res?.error || 'not connected'}`, time: Date.now() }]);
    }
  };

  const formatChatTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const sendCmd = async (cmd) => {
    if (!controlEnabled) return;
    const res = await window.api?.controlSend(cmd);
    setLastCmdStatus(res?.ok ? `✓ ${cmd}` : `✗ ${cmd}: ${res?.error}`);
  };

  // Mouse deltas are accumulated and flushed once per animation frame: one
  // command per frame instead of one per mouse event, with the sub-pixel
  // remainder carried over so slow movements aren't lost.
  const moveAcc = useRef({ dx: 0, dy: 0, raf: 0 });
  const sendMouseMove = (e) => {
    if (!controlEnabled) return;
    const a = moveAcc.current;
    // Compensate for zoom: at 2x zoom, 10px of screen movement is 5px remotely.
    a.dx += e.movementX / zoom;
    a.dy += e.movementY / zoom;
    if (a.raf) return;
    a.raf = requestAnimationFrame(() => {
      a.raf = 0;
      const dx = Math.round(a.dx), dy = Math.round(a.dy);
      a.dx -= dx;
      a.dy -= dy;
      if (dx || dy) window.api?.controlSend(`mouse_move:${dx},${dy}`);
    });
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

  // Shared look of the two remote-screen elements (<img> for JPEG/PNG, <canvas>
  // for H.264); only the one matching the current codec is displayed.
  const screenStyle = (show) => ({
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: show ? 'block' : 'none',
    transform: `scale(${zoom})`,
    transformOrigin: 'center center',
    transition: zoom === 1 ? 'none' : 'transform 0.1s ease-out',
  });

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
            <div className="box-title">Connect To</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button
                className={`btn ${connectMode === 'ip' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ flex: 1, padding: '6px 0', fontSize: 12 }}
                onClick={() => setConnectMode('ip')}
              >
                IP Address
              </button>
              <button
                className={`btn ${connectMode === 'id' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ flex: 1, padding: '6px 0', fontSize: 12 }}
                onClick={() => setConnectMode('id')}
              >
                Device ID
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {connectMode === 'ip' ? (
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
              ) : (
                <div className="field">
                  <label className="field-label">Device ID</label>
                  <input
                    className="field-input"
                    placeholder="123456789"
                    value={deviceIdInput}
                    onChange={e => setDeviceIdInput(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={e => e.key === 'Enter' && connect()}
                  />
                  <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                    Only finds devices on the same local network
                  </div>
                </div>
              )}

              <div className="field">
                <label className="field-label">Password</label>
                <input
                  className="field-input"
                  type="password"
                  placeholder="Shown on the host's Server page"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
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

          {phase === 'connecting' && pairStatus && (
            <div style={{
              fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--accent-2)',
              padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 'var(--r)',
              border: '1px solid var(--border)',
            }}>
              ⏳ {pairStatus}
            </div>
          )}

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
              <p>{phase === 'connecting' ? (pairStatus || 'Connecting...') : 'Enter connection details and click Connect'}</p>
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
          {controlEnabled ? 'Control Active' : controlPending ? 'Waiting for Host' : 'View Only'}
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
            <button className="btn btn-success" onClick={enableControl} disabled={controlPending}>
              {controlPending ? '⏳ Waiting for host...' : '🖱 Enable Control'}
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
        <div className="main-content-row">
          <div className="main-content-col">
            <div
              className="view-area"
              style={{
                cursor: controlEnabled ? 'crosshair' : 'default',
                overflow: zoom > 1 ? 'auto' : 'hidden',
              }}
              onMouseMove={controlEnabled ? sendMouseMove : undefined}
              onMouseDown={controlEnabled ? sendMouseClick : undefined}
              onContextMenu={e => controlEnabled && e.preventDefault()}
            >
              {hasFrame ? (
                <>
                  <img
                    className="screen-img"
                    ref={setImgEl}
                    alt="Remote Screen"
                    draggable={false}
                    style={screenStyle(viewMode === 'image')}
                  />
                  <canvas
                    className="screen-img"
                    ref={setCanvasEl}
                    style={screenStyle(viewMode === 'video')}
                  />
                  {videoNote && (
                    <div style={{
                      position: 'absolute', left: 8, bottom: 8, right: 8,
                      background: 'rgba(0,0,0,0.65)', color: 'var(--text-1)',
                      borderRadius: 7, padding: '6px 11px',
                      fontSize: 11, fontFamily: 'var(--font-mono)',
                    }}>
                      {videoNote}
                    </div>
                  )}
                </>
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
              <button className="btn btn-icon" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out">
                − 
              </button>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', minWidth: 40, textAlign: 'center' }}>
                {Math.round(zoom * 100)}%
              </span>
              <button className="btn btn-icon" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in">
                +
              </button>
              {zoom !== 1 && (
                <button className="btn btn-icon" onClick={zoomReset} title="Reset zoom">
                  Reset
                </button>
              )}
              <span className="toolbar-sep" />
              {hasAudio && (
                <button
                  className={`btn btn-icon ${audioMuted ? '' : 'active'}`}
                  onClick={toggleAudioMute}
                  title={audioMuted ? 'Host audio is muted — click to listen' : 'Listening to host audio — click to mute'}
                >
                  {audioMuted ? '🔇 Audio off' : '🔊 Audio'}
                </button>
              )}
              {isCapturing && (
                <div className="live-badge">
                  <span className="pulse-dot" style={{ width: 5, height: 5 }} />
                  LIVE • {fps} FPS
                </div>
              )}
              {/* Only shown at all if the host currently has chat turned
                  on — see the CHAT_STATE listener above. */}
              {chatAllowed && (
                <button
                  className={`btn btn-icon ${chatOpen ? 'active' : ''}`}
                  onClick={() => setChatOpen(o => !o)}
                  title="Chat with the host"
                >
                  💬 Chat
                </button>
              )}
              <button className="btn btn-icon" style={{ color: 'var(--danger)' }} onClick={disconnect}>
                ✕ Disconnect
              </button>
            </div>
          </div>

          {/* Chat panel — only reachable when chatAllowed is true, and
              auto-closes if the host turns chat off mid-session. */}
          {chatOpen && chatAllowed && (
            <div className="chat-panel">
              <div className="chat-header">
                <div>
                  <div className="sidebar-title" style={{ fontSize: 15 }}>Chat</div>
                  <div className="sidebar-sub">WITH HOST</div>
                </div>
                <button className="btn btn-icon" onClick={() => setChatOpen(false)} title="Close">
                  ✕
                </button>
              </div>

              <div className="chat-messages" ref={chatScrollRef}>
                {chatMessages.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', textAlign: 'center', marginTop: 20 }}>
                    No messages yet
                  </div>
                )}
                {chatMessages.map(m => (
                  <div key={m.id} className={`chat-message ${m.from === 'You' ? 'from-host' : 'from-remote'}`}>
                    {m.from && m.from !== 'You' && (
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
                    <div className="chat-message-time">
                      {m.from === 'You' ? (m.scope === 'host' ? '🔒 Host only · ' : 'Everyone · ') : ''}
                      {formatChatTime(m.time)}
                    </div>
                  </div>
                ))}
              </div>

              {/* Who do my messages go to? Applies to text and files. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0' }}>
                <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>SEND TO</span>
                {[{ key: 'all', label: 'Everyone' }, { key: 'host', label: 'Host only' }].map(opt => (
                  <button
                    key={opt.key}
                    className={`btn ${chatTarget === opt.key ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ width: 'auto', padding: '3px 10px', fontSize: 10 }}
                    onClick={() => setChatTarget(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="chat-input-row">
                <button
                  className="btn btn-ghost chat-attach-btn"
                  title={chatTarget === 'host' ? 'Send a file to the host only' : 'Send a file to everyone'}
                  disabled={fileSending}
                  onClick={sendClientFile}
                >
                  {fileSending ? '…' : '📎'}
                </button>
                <input
                  className="field-input chat-text-input"
                  placeholder={chatTarget === 'host' ? 'Message to host only…' : 'Message to everyone…'}
                  value={chatDraft}
                  onChange={e => setChatDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendClientChatMessage()}
                />
                <button className="btn btn-primary chat-send-btn" title="Send message" onClick={sendClientChatMessage}>
                  ➤
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}