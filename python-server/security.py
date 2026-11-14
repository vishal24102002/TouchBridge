"""TLS + pairing (password + host acceptance) + LAN device discovery.

TouchBridge has no cloud/relay backend. That has two consequences worth
being upfront about:

  * "Connect by ID" resolves an ID to an IP via a UDP broadcast on the
    local network (see run_discovery_responder / the client-side resolver
    in electron.js) — it works within the same LAN/Wi-Fi segment (or a VPN
    that relays broadcasts), not across the open internet. Connecting by
    direct IP always works wherever the host is reachable, exactly as
    before; ID is just a friendlier way to find that IP on a local network.

  * TLS here uses a self-signed certificate generated once per install,
    not one signed by a public CA — there's no third party to vouch for
    it. That still encrypts every byte on the wire (nobody sniffing the
    network can read frames or keystrokes), but on its own it can't prove
    identity against an attacker on the same LAN. The client pins the
    certificate's SHA-256 fingerprint the first time it connects to a
    given host (trust-on-first-use, the same model SSH uses) and refuses
    to proceed if a *later* connection to that same host presents a
    different one — that's what actually catches a man-in-the-middle
    after the first successful connection.

On top of the TLS transport, every connection — however the host was
found — must pass a password check AND be explicitly Accepted by the
host (via a prompt in the desktop UI) before it's issued a session token.
Screen-frame requests and control commands both require a valid token;
neither channel trusts the network layer alone.
"""

import os
import json
import time
import ssl
import socket
import secrets
import string
import threading
from datetime import datetime, timedelta

DISCOVERY_PORT = 47821
DISCOVERY_MAGIC = "TOUCHBRIDGE_DISCOVER"
TOKEN_TTL_SECONDS = 12 * 60 * 60  # a session token is good for 12 hours
PAIR_TIMEOUT_SECONDS = 60         # how long a pairing request waits for the host


def _log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ─────────────────────────────────────────────────────────────────────────
# Device identity — a persistent 9-digit ID + a password, stored in
# <config_dir>/device.json. The password defaults to a random 6-character
# code (in the spirit of TeamViewer/AnyDesk session passwords) and the
# host can change or regenerate it from Settings.
# ─────────────────────────────────────────────────────────────────────────
class DeviceIdentity:
    def __init__(self, config_dir: str):
        self.path = os.path.join(config_dir, "device.json")
        os.makedirs(config_dir, exist_ok=True)
        self._lock = threading.Lock()
        self._load_or_create()

    def _load_or_create(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, "r") as f:
                    data = json.load(f)
                self.device_id = data["id"]
                self.password = data["password"]
                return
            except Exception:
                pass  # corrupt file — fall through and regenerate
        self.device_id = "".join(secrets.choice(string.digits) for _ in range(9))
        self.password = self._gen_password()
        self._save()

    @staticmethod
    def _gen_password() -> str:
        alphabet = string.ascii_uppercase + string.digits
        return "".join(secrets.choice(alphabet) for _ in range(6))

    def _save(self):
        with open(self.path, "w") as f:
            json.dump({"id": self.device_id, "password": self.password}, f)

    def regenerate_password(self) -> str:
        with self._lock:
            self.password = self._gen_password()
            self._save()
            return self.password

    def set_password(self, new_password: str):
        new_password = (new_password or "").strip()
        if not new_password:
            raise ValueError("password cannot be empty")
        with self._lock:
            self.password = new_password
            self._save()

    def check_password(self, candidate: str) -> bool:
        with self._lock:
            return secrets.compare_digest(candidate or "", self.password)

    def info(self):
        with self._lock:
            return {"id": self.device_id, "password": self.password}


# ─────────────────────────────────────────────────────────────────────────
# TLS — self-signed cert generated once per config_dir and reused after.
# ─────────────────────────────────────────────────────────────────────────
def ensure_certificate(config_dir: str):
    cert_path = os.path.join(config_dir, "cert.pem")
    key_path = os.path.join(config_dir, "key.pem")
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError as e:
        raise RuntimeError(
            "The 'cryptography' package is required to generate TouchBridge's "
            "TLS certificate. Install it with: pip install cryptography"
        ) from e

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TouchBridge")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow() - timedelta(days=1))
        .not_valid_after(datetime.utcnow() + timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("touchbridge.local")]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    os.makedirs(config_dir, exist_ok=True)
    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    return cert_path, key_path


def build_server_ssl_context(config_dir: str) -> ssl.SSLContext:
    cert_path, key_path = ensure_certificate(config_dir)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert_path, key_path)
    return ctx


# ─────────────────────────────────────────────────────────────────────────
# Pairing — password check + host acceptance -> short-lived session token.
# One PairingManager instance per running server; `on_change` is called
# whenever the pending-request list changes, so server.py can broadcast it
# to the host UI the same way it already does for connected control clients.
# ─────────────────────────────────────────────────────────────────────────
class _PendingRequest:
    def __init__(self, req_id: int, addr: str, label: str):
        self.id = req_id
        self.addr = addr
        self.label = label
        self.requested_at = time.time()
        self.event = threading.Event()
        self.decision = None  # 'accepted' | 'denied' | None (timed out)


class PairingManager:
    def __init__(self, identity: DeviceIdentity, on_change=None):
        self.identity = identity
        self.on_change = on_change or (lambda: None)
        self._lock = threading.Lock()
        self._pending = {}   # req_id -> _PendingRequest
        self._tokens = {}    # token -> expiry epoch
        self._next_id = 1

    def request(self, addr, label: str, timeout: float = PAIR_TIMEOUT_SECONDS):
        """Blocks the calling (per-connection) thread until the host
        accepts, denies, or the request times out. Returns a fresh session
        token on acceptance, or None otherwise."""
        with self._lock:
            req_id = self._next_id
            self._next_id += 1
            pr = _PendingRequest(req_id, addr[0], label)
            self._pending[req_id] = pr
        self.on_change()

        pr.event.wait(timeout)

        with self._lock:
            self._pending.pop(req_id, None)
        self.on_change()

        if pr.decision != "accepted":
            return None

        token = secrets.token_hex(24)
        with self._lock:
            self._tokens[token] = {"expiry": time.time() + TOKEN_TTL_SECONDS, "label": label}
        return token

    def list_pending(self):
        with self._lock:
            return [
                {"id": pr.id, "addr": pr.addr, "label": pr.label, "requestedAt": pr.requested_at}
                for pr in self._pending.values()
            ]

    def decide(self, req_id: int, accepted: bool) -> bool:
        with self._lock:
            pr = self._pending.get(req_id)
        if not pr:
            return False
        pr.decision = "accepted" if accepted else "denied"
        pr.event.set()
        return True

    def validate(self, token: str) -> bool:
        if not token:
            return False
        with self._lock:
            entry = self._tokens.get(token)
            if entry is None:
                return False
            if entry["expiry"] < time.time():
                del self._tokens[token]
                return False
            return True

    def label_for(self, token: str) -> str:
        """The human-readable label this token's device paired with, or a
        generic fallback — used to attribute chat messages and anything
        else that wants a friendly name rather than a raw IP."""
        with self._lock:
            entry = self._tokens.get(token)
            return entry["label"] if entry else "Unknown device"

    def revoke_token(self, token: str):
        with self._lock:
            self._tokens.pop(token, None)


# ─────────────────────────────────────────────────────────────────────────
# LAN discovery — resolves a Device ID to an IP via UDP broadcast. Only
# works within the same broadcast domain; see module docstring.
# ─────────────────────────────────────────────────────────────────────────
def run_discovery_responder(identity: DeviceIdentity, hostname: str, port: int = DISCOVERY_PORT):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except Exception:
        pass
    try:
        sock.bind(("0.0.0.0", port))
    except Exception as e:
        _log(f"[ERR] discovery responder failed to bind UDP :{port}: {e}")
        return

    _log(f"Discovery responder listening on UDP :{port} (device id {identity.device_id})")
    while True:
        try:
            data, addr = sock.recvfrom(512)
            msg = json.loads(data.decode("utf-8", errors="ignore"))
            if msg.get("magic") != DISCOVERY_MAGIC or msg.get("type") != "query":
                continue
            if msg.get("id") != identity.device_id:
                continue  # not us — ignore, don't reply
            reply = json.dumps({
                "magic": DISCOVERY_MAGIC,
                "type": "reply",
                "id": identity.device_id,
                "hostname": hostname,
            }).encode("utf-8")
            sock.sendto(reply, addr)
        except Exception as e:
            _log(f"[ERR] discovery responder: {e}")