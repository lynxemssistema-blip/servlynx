#!/usr/bin/env python3
"""
ServLynx Explorer — Servidor Web Local (porta 8090) & Supervisor do Agente QNAP
Permite acessar http://localhost:8090 diretamente na rede local e garante
que o agente nativo no QNAP (192.168.15.44) esteja conectado a https://servlynx.lynxems.com.br
"""

import os
import sys
import json
import time
import hashlib
import secrets
import threading
import mimetypes
import posixpath
import urllib.parse
import urllib.request
from email.parser import BytesParser
from email.policy import default as email_default_policy
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import paramiko

if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 8090))

def _load_local_secret(key, default=""):
    val = os.environ.get(key)
    if val:
        return val
    try:
        sec_path = os.path.join(BASE_DIR, "secrets.json")
        if os.path.exists(sec_path):
            with open(sec_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get(key):
                return str(data.get(key))
    except Exception:
        pass
    return default


QNAP_HOST = os.environ.get("QNAP_HOST", "192.168.15.44")
QNAP_USER = os.environ.get("QNAP_USER", "admin")
QNAP_PASS = _load_local_secret("QNAP_PASS")
QNAP_BASE = "/share/CACHEDEV1_DATA"
REMOTE_GATEWAY = "https://servlynx.lynxems.com.br/api.php"

USERS_FILE = os.path.join(BASE_DIR, "local_users.json")
SESSIONS = {}


def hash_pw(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(12)
    digest = hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()
    return f"sha256${salt}${digest}"


def verify_pw(password, stored):
    parts = (stored or "").split("$")
    if len(parts) == 3 and parts[0] == "sha256":
        calc = hashlib.sha256(f"{parts[1]}:{password}".encode("utf-8")).hexdigest()
        return secrets.compare_digest(parts[2], calc)
    return False


def load_users():
    if not os.path.exists(USERS_FILE):
        init_pass = _load_local_secret("SERVLYNX_MASTER_INIT_PASS") or secrets.token_urlsafe(16)
        users = [
            {
                "id": "usr_master_edson",
                "name": "Edson Manoel",
                "email": "edsonmanoel2012@gmail.com",
                "username": "edsonmanoel2012@gmail.com",
                "password_hash": hash_pw(init_pass),
                "role": "admin",
                "active": True,
                "allowed_shares": ["*"],
                "permissions": {
                    "read": True, "write": True, "delete": True,
                    "manage_users": True, "manage_shares": True, "manage_qnap": True
                }
            }
        ]
        save_users(users)
        return users
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2, ensure_ascii=False)


class QNAPClient:
    def __init__(self):
        self.lock = threading.Lock()
        self.ssh = None
        self.sftp = None

    def _connect(self):
        if self.ssh and self.ssh.get_transport() and self.ssh.get_transport().is_active():
            return
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(
            QNAP_HOST,
            username=QNAP_USER,
            password=QNAP_PASS,
            timeout=8,
            look_for_keys=False,
            allow_agent=False,
            disabled_algorithms={"pubkeys": ["rsa-sha2-256", "rsa-sha2-512"]},
        )
        self.ssh = c
        self.sftp = c.open_sftp()

    def exec(self, cmd):
        with self.lock:
            try:
                self._connect()
                _, out, err = self.ssh.exec_command(cmd, timeout=25)
                return out.read().decode("utf-8", errors="replace"), err.read().decode("utf-8", errors="replace")
            except Exception:
                self.ssh = None
                self.sftp = None
                self._connect()
                _, out, err = self.ssh.exec_command(cmd, timeout=25)
                return out.read().decode("utf-8", errors="replace"), err.read().decode("utf-8", errors="replace")

    def run_bridge_rpc(self, action, payload=None):
        """Executa exatamente o mesmo dispatch_task do qnap_bridge.py diretamente no QNAP via stdin."""
        task_json = json.dumps({"action": action, "payload": payload or {}}, ensure_ascii=False)
        py_cmd = (
            "/mnt/ext/opt/Python/bin/python -c "
            "\"import sys, json; sys.path.insert(0, '/share/CACHEDEV1_DATA/.servlynx'); "
            "import qnap_bridge as qb; task=json.loads(sys.stdin.read()); "
            "print(json.dumps(qb.dispatch_task(task)))\""
        )
        with self.lock:
            self._connect()
            stdin, stdout, stderr = self.ssh.exec_command(py_cmd, timeout=30)
            stdin.write(task_json)
            stdin.channel.shutdown_write()
            out = stdout.read().decode("utf-8", errors="replace").strip()
            err = stderr.read().decode("utf-8", errors="replace").strip()
            if not out:
                return {"ok": False, "error": err or "Sem resposta do QNAP"}
            return json.loads(out.splitlines()[-1])


qnap = QNAPClient()


def ensure_qnap_agent_supervisor():
    """Verifica a cada 30s se o agente ponte residente no QNAP esta ativo."""
    while True:
        try:
            out, _ = qnap.exec("ps | grep '[q]nap_bridge.py'")
            if "qnap_bridge.py" not in out:
                print("[Supervisor] Iniciando qnap_bridge.py no QNAP...")
                qnap.exec(
                    "/mnt/ext/opt/Python/bin/python /share/CACHEDEV1_DATA/.servlynx/qnap_bridge.py --daemon"
                )
        except Exception as e:
            print(f"[Supervisor] Aviso ao checar QNAP: {e}")
        time.sleep(30)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, data, code=200):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self):
        ln = int(self.headers.get("Content-Length", "0"))
        if ln <= 0:
            return {}
        return json.loads(self.rfile.read(ln).decode("utf-8"))

    def _current_user(self):
        auth = self.headers.get("Authorization", "")
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1].strip()
        if not token:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            token = (qs.get("token") or [""])[0]
        uid = SESSIONS.get(token)
        if not uid:
            return None
        for u in load_users():
            if u["id"] == uid and u.get("active", True):
                return u
        return None

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
            return
        if parsed.path in ("/styles.css", "/app.js", "/manifest.json", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png"):
            forced = "application/manifest+json; charset=utf-8" if parsed.path == "/manifest.json" else None
            self._serve_file(parsed.path.lstrip("/"), forced)
            return
        if parsed.path == "/api.php":
            self._handle_api("GET", parsed)
            return
        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api.php":
            self._handle_api("POST", parsed)
            return
        self.send_error(404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api.php":
            self._handle_api("PUT", parsed)
            return
        self.send_error(404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api.php":
            self._handle_api("DELETE", parsed)
            return
        self.send_error(404)

    def _serve_file(self, rel, forced_mime=None):
        fpath = os.path.join(BASE_DIR, rel)
        if not os.path.isfile(fpath):
            self.send_error(404)
            return
        mime = forced_mime or (mimetypes.guess_type(fpath)[0] or "application/octet-stream")
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_api(self, method, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        route = (qs.get("route") or [""])[0]

        if route == "health":
            self._send_json({"ok": True, "bridge_online": True, "mode": "local"})
            return

        if route == "login" and method == "POST":
            body = self._read_json()
            login = (body.get("email") or body.get("username") or "").strip().lower()
            pw = body.get("password") or ""
            for u in load_users():
                if u["email"].lower() == login or u.get("username", "").lower() == login:
                    if verify_pw(pw, u["password_hash"]):
                        tok = "loc_" + secrets.token_hex(20)
                        SESSIONS[tok] = u["id"]
                        pub = {k: v for k, v in u.items() if k != "password_hash"}
                        self._send_json({"ok": True, "token": tok, "user": pub, "bridge_online": True})
                        return
            self._send_json({"ok": False, "error": "Credenciais invalidas."}, 401)
            return

        user = self._current_user()
        if not user:
            self._send_json({"ok": False, "error": "Sessao nao autenticada."}, 401)
            return

        if route == "me":
            pub = {k: v for k, v in user.items() if k != "password_hash"}
            self._send_json({"ok": True, "user": pub, "bridge_online": True})
            return

        if route == "connect_qnap":
            t0 = time.time()
            dir_res = qnap.run_bridge_rpc("list_dir", {"path": "/", "show_hidden": False})
            st_res = qnap.run_bridge_rpc("qnap_status", {}) if dir_res.get("ok") else {}
            lat = int(round((time.time() - t0) * 1000))
            self._send_json({
                "ok": bool(dir_res.get("ok")),
                "bridge_online": True,
                "latency_ms": lat,
                "shares_count": len(dir_res.get("items") or []),
                "shares": dir_res.get("items") or [],
                "status": st_res.get("status")
            })
            return

        if route == "drive_installer":
            share = (qs.get("share") or ["Public"])[0]
            bat = (
                "@echo off\r\n"
                "title ServLynx Drive Local (L:)\r\n"
                "net use L: /delete /y >nul 2>&1\r\n"
                f"net use L: \"\\\\{QNAP_HOST}\\{share}\" /user:{QNAP_USER} * /persistent:yes\r\n"
                "if %ERRORLEVEL%==0 start explorer.exe L:\\\r\n"
                "pause\r\n"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="Montar_Disco_ServLynx_L.bat"')
            self.send_header("Content-Length", str(len(bat)))
            self.end_headers()
            self.wfile.write(bat)
            return

        if route == "download":
            rel = (qs.get("path") or [""])[0].replace("\\", "/").lstrip("/")
            inline = (qs.get("inline") or [""])[0] in ("1", "true")
            remote = posixpath.normpath(posixpath.join(QNAP_BASE, rel))
            if not remote.startswith(QNAP_BASE + "/"):
                self._send_json({"ok": False, "error": "Caminho invalido"}, 400)
                return
            try:
                with qnap.lock:
                    qnap._connect()
                    st = qnap.sftp.stat(remote)
                    fsize = st.st_size
                    rng = self.headers.get("Range", "")
                    start, end = 0, max(0, fsize - 1)
                    is_rng = False
                    if fsize > 0 and rng.lower().startswith("bytes="):
                        parts = rng.split("=", 1)[1].split("-", 1)
                        start = int(parts[0]) if parts[0] else 0
                        end = min(fsize - 1, int(parts[1])) if len(parts) > 1 and parts[1] else fsize - 1
                        is_rng = True
                    length = (end - start + 1) if fsize > 0 else 0
                    with qnap.sftp.open(remote, "rb") as rf:
                        if start > 0:
                            rf.seek(start)
                        data = rf.read(length) if length > 0 else b""
                mime = mimetypes.guess_type(remote)[0] or "application/octet-stream"
                self.send_response(206 if is_rng else 200)
                self.send_header("Content-Type", mime)
                self.send_header("Accept-Ranges", "bytes")
                if is_rng:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{fsize}")
                disp = "inline" if inline else "attachment"
                self.send_header("Content-Disposition", f'{disp}; filename="{posixpath.basename(remote)}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, 404)
            return

        if route == "upload" and method == "POST":
            ctype = self.headers.get("Content-Type", "")
            ln = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(ln)
            msg = BytesParser(policy=email_default_policy).parsebytes(
                f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + raw_body
            )
            target_rel = "/"
            files_to_save = []
            for part in msg.iter_parts():
                cd = part.get("Content-Disposition", "")
                if 'name="path"' in cd:
                    target_rel = part.get_content().strip()
                elif part.get_filename():
                    files_to_save.append((posixpath.basename(part.get_filename()), part.get_payload(decode=True)))
            rel_clean = target_rel.replace("\\", "/").lstrip("/")
            remote_dir = posixpath.normpath(posixpath.join(QNAP_BASE, rel_clean))
            if not remote_dir.startswith(QNAP_BASE + "/"):
                self._send_json({"ok": False, "error": "Abra uma pasta compartilhada antes de enviar."}, 400)
                return
            uploaded = []
            with qnap.lock:
                qnap._connect()
                for fname, fbytes in files_to_save:
                    rfile = posixpath.join(remote_dir, fname)
                    with qnap.sftp.open(rfile, "wb") as wf:
                        wf.write(fbytes)
                    uploaded.append(fname)
            self._send_json({"ok": True, "uploaded": uploaded, "errors": []})
            return

        if route == "update_profile" and method == "POST":
            body = self._read_json()
            cur_pw = body.get("current_password") or ""
            if not cur_pw or not verify_pw(cur_pw, user.get("password_hash", "")):
                self._send_json({"ok": False, "error": "Senha atual incorreta."}, 403)
                return
            new_name = (body.get("name") or user.get("name", "")).strip()
            new_email = (body.get("email") or body.get("username") or user.get("email", "")).strip()
            new_pw = body.get("new_password") or ""
            if not new_name or not new_email:
                self._send_json({"ok": False, "error": "Nome e login/e-mail obrigatorios."}, 400)
                return
            if new_pw and len(new_pw) < 4:
                self._send_json({"ok": False, "error": "Nova senha deve ter no minimo 4 caracteres."}, 400)
                return
            users = load_users()
            for other in users:
                if other["id"] != user["id"] and (
                    other.get("email", "").lower() == new_email.lower()
                    or other.get("username", "").lower() == new_email.lower()
                ):
                    self._send_json({"ok": False, "error": "Login/e-mail ja em uso por outro usuario."}, 409)
                    return
            updated = None
            for u in users:
                if u["id"] == user["id"]:
                    u["name"] = new_name
                    u["email"] = new_email
                    u["username"] = new_email
                    if new_pw:
                        u["password_hash"] = hash_pw(new_pw)
                    updated = u
                    break
            save_users(users)
            pub = {k: v for k, v in updated.items() if k != "password_hash"}
            self._send_json({"ok": True, "user": pub})
            return

        if route == "files":
            p = (qs.get("path") or ["/"])[0]
            hidden = (qs.get("hidden") or ["0"])[0] == "1"
            self._send_json(qnap.run_bridge_rpc("list_dir", {"path": p, "show_hidden": hidden}))
            return

        if route in ("mkdir", "touch", "rename", "copy", "move", "delete", "save_text"):
            body = self._read_json()
            act = "write_text" if route == "save_text" else route
            self._send_json(qnap.run_bridge_rpc(act, body))
            return

        if route == "preview":
            p = (qs.get("path") or [""])[0]
            self._send_json(qnap.run_bridge_rpc("read_text", {"path": p}))
            return

        if route == "search":
            p = (qs.get("path") or ["/"])[0]
            q = (qs.get("q") or [""])[0]
            self._send_json(qnap.run_bridge_rpc("search", {"path": p, "query": q}))
            return

        if route == "properties":
            p = (qs.get("path") or ["/"])[0]
            self._send_json(qnap.run_bridge_rpc("properties", {"path": p}))
            return

        if route == "qnap_status":
            self._send_json(qnap.run_bridge_rpc("qnap_status", {}))
            return

        if route == "shares":
            if method == "GET":
                self._send_json(qnap.run_bridge_rpc("list_shares", {}))
            elif method == "POST":
                self._send_json(qnap.run_bridge_rpc("create_share", self._read_json()))
            elif method == "DELETE":
                self._send_json(qnap.run_bridge_rpc("delete_share", self._read_json()))
            return

        if route == "qnap_action" and method == "POST":
            self._send_json(qnap.run_bridge_rpc("qnap_action", self._read_json()))
            return

        if route == "users":
            users = load_users()
            if method == "GET":
                qu = qnap.run_bridge_rpc("list_qnap_users", {})
                self._send_json({
                    "ok": True,
                    "users": [{k: v for k, v in u.items() if k != "password_hash"} for u in users],
                    "qnap_users": qu.get("users", [])
                })
                return
            if method == "POST":
                body = self._read_json()
                new_u = {
                    "id": "usr_" + secrets.token_hex(6),
                    "name": body.get("name", ""),
                    "email": body.get("email", ""),
                    "username": body.get("email", ""),
                    "password_hash": hash_pw(body.get("password", "")),
                    "role": body.get("role", "user"),
                    "active": True,
                    "allowed_shares": body.get("allowed_shares", ["*"]),
                    "permissions": body.get("permissions", {"read": True, "write": True})
                }
                users.append(new_u)
                save_users(users)
                self._send_json({"ok": True, "user": {k: v for k, v in new_u.items() if k != "password_hash"}})
                return

        self._send_json({"ok": False, "error": f"Rota {route} nao disponivel no modo local."}, 404)


def main():
    t = threading.Thread(target=ensure_qnap_agent_supervisor, daemon=True)
    t.start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"ServLynx Explorer Local rodando em http://localhost:{PORT}")
    print(f"Supervisor do QNAP ({QNAP_HOST}) ativo para https://servlynx.lynxems.com.br")
    srv.serve_forever()


if __name__ == "__main__":
    main()
