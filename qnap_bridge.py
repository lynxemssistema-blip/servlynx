#!/mnt/ext/opt/Python/bin/python
# -*- coding: utf-8 -*-
"""
ServLynx QNAP Native Bridge Agent (Python 2.7 - roda direto no QNAP TS-231P)
Conecta o QNAP NAS diretamente ao portal https://servlynx.lynxems.com.br
"""
from __future__ import print_function
import os
import sys
import json
import time
import shutil
import zipfile
import mimetypes
import subprocess
import re
import fcntl

try:
    from urllib import quote as urlquote
except ImportError:
    from urllib.parse import quote as urlquote

def _load_local_secret(key, default=""):
    val = os.environ.get(key)
    if val:
        return val
    try:
        sec_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secrets.json")
        if os.path.exists(sec_path):
            with open(sec_path, "r") as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get(key):
                return str(data.get(key))
    except Exception:
        pass
    return default


BASE_SHARE_DIR = "/share/CACHEDEV1_DATA"
API_URL = os.environ.get("SERVLYNX_API_URL", "https://servlynx.lynxems.com.br/api.php")
BRIDGE_SECRET = _load_local_secret("SERVLYNX_BRIDGE_SECRET")
AGENT_ID = "qnap-native-NAS09534B"
CURL_BIN = "/sbin/curl" if os.path.exists("/sbin/curl") else "curl"

HIDDEN_SYSTEM_NAMES = set([
    "aquota.user", "lost+found", ".@app_center", ".@backup_config",
    ".@backup_qbox", ".@qmariadb", ".@qmonitor", ".@qsync", ".antivirus",
    ".appDB", ".idmap", ".ldapdb", ".locks", ".log", ".nc", ".php_session",
    ".php_session_sys", ".qbox", ".qpkg", ".samba", ".servlynx", ".spool",
    ".swap", ".system", ".team_folder", ".torrent", ".versioning"
])


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print("[%s] %s" % (ts, msg))
    sys.stdout.flush()


def b_str(s):
    if isinstance(s, unicode):
        return s.encode("utf-8")
    return str(s)


def u_str(s):
    if isinstance(s, unicode):
        return s
    return str(s).decode("utf-8", "replace")


def safe_join(rel_path):
    rel = b_str(rel_path or "/").replace("\\", "/")
    parts = [p for p in rel.split("/") if p and p != "."]
    clean = []
    for p in parts:
        if p == "..":
            if clean:
                clean.pop()
        else:
            clean.append(p)
    full = os.path.realpath(os.path.join(BASE_SHARE_DIR, *clean))
    base_real = os.path.realpath(BASE_SHARE_DIR)
    if full != base_real and not full.startswith(base_real + "/"):
        raise ValueError("Caminho fora do volume permitido")
    if clean:
        share_real = os.path.realpath(os.path.join(BASE_SHARE_DIR, clean[0]))
        if share_real != base_real and not share_real.startswith(base_real + "/"):
            raise ValueError("Compartilhamento fora do volume permitido")
        if full != share_real and not full.startswith(share_real + "/"):
            raise ValueError("Caminho escapa da pasta raiz do compartilhamento")
    return full, "/" + "/".join([u_str(x) for x in clean])


def _normalize_deny_paths(deny_paths):
    out = []
    for d in (deny_paths or []):
        parts = [p for p in u_str(d).replace("\\", "/").split("/") if p and p != "."]
        if parts:
            out.append("/" + "/".join(parts))
    return out


def _is_rel_denied(rel_norm, deny_set):
    if not deny_set:
        return False
    rn = u_str(rel_norm).rstrip("/") or "/"
    for d in deny_set:
        if rn == d or rn.startswith(d + "/"):
            return True
    return False


def _has_denied_descendant(rel_norm, deny_set):
    if not deny_set:
        return False
    rn = u_str(rel_norm).rstrip("/") or "/"
    prefix = "/" if rn == "/" else (rn + "/")
    for d in deny_set:
        if d == rn or d.startswith(prefix):
            return True
    return False


def human_size(n):
    try:
        n = float(n)
    except Exception:
        return "0 B"
    for u in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024.0 or u == "TB":
            if u == "B":
                return "%d B" % int(n)
            return "%.2f %s" % (n, u)
        n /= 1024.0
    return "0 B"


def run_cmd(cmd_list, input_data=None):
    p = subprocess.Popen(
        cmd_list,
        stdin=subprocess.PIPE if input_data is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    out, err = p.communicate(input=input_data)
    return p.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def curl_json(route, payload=None, query="", timeout=20):
    url = "%s?route=%s%s" % (API_URL, urlquote(route), ("&" + query) if query else "")
    cmd = [
        CURL_BIN, "-sk", "--max-time", str(timeout),
        "-H", "X-Bridge-Secret: " + BRIDGE_SECRET
    ]
    if payload is not None:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-"]
        data_bytes = json.dumps(payload).encode("utf-8")
    else:
        data_bytes = None
    cmd.append(url)
    rc, out, err = run_cmd(cmd, input_data=data_bytes)
    if rc != 0:
        raise RuntimeError("curl failed (%s): %s" % (rc, err.strip()))
    return json.loads(out)


def mode_str(st_mode, is_dir):
    perms = ""
    for shift in (6, 3, 0):
        v = (st_mode >> shift) & 7
        perms += ("r" if v & 4 else "-") + ("w" if v & 2 else "-") + ("x" if v & 1 else "-")
    return ("d" if is_dir else "-") + perms


def parse_smb_token_list(raw_val):
    tokens = []
    if not raw_val:
        return tokens
    raw = raw_val.strip()
    if "," in raw or '"' in raw or "'" in raw:
        parts = raw.split(",")
    else:
        parts = raw.split()
    for part in parts:
        t = part.strip()
        if not t:
            continue
        if t.startswith('@"') and t.endswith('"'):
            t = "@" + t[2:-1].strip()
        elif t.startswith("@'") and t.endswith("'"):
            t = "@" + t[2:-1].strip()
        elif (t.startswith('"') and t.endswith('"')) or (t.startswith("'") and t.endswith("'")):
            t = t[1:-1].strip()
        if t and t not in tokens:
            tokens.append(t)
    return tokens


def parse_smb_shares():
    shares = {}
    conf = "/etc/config/smb.conf"
    if not os.path.exists(conf):
        return shares
    cur = None
    try:
        with open(conf, "r") as f:
            for line in f:
                s = line.strip()
                if s.startswith("[") and s.endswith("]"):
                    sec = s[1:-1].strip()
                    if sec.lower() not in ("global", "printers", "homes", "home"):
                        cur = sec
                        shares[cur] = {
                            "name": cur,
                            "comment": "",
                            "path": "",
                            "public": "",
                            "valid_users": [],
                            "write_list": [],
                            "read_list": [],
                            "invalid_users": []
                        }
                    else:
                        cur = None
                elif cur and "=" in s:
                    k, v = [x.strip() for x in s.split("=", 1)]
                    kl = k.lower()
                    if kl == "comment":
                        shares[cur]["comment"] = v
                    elif kl == "path":
                        shares[cur]["path"] = v
                    elif kl == "public":
                        shares[cur]["public"] = v.lower()
                    elif kl == "valid users":
                        shares[cur]["valid_users"] = parse_smb_token_list(v)
                    elif kl == "write list":
                        shares[cur]["write_list"] = parse_smb_token_list(v)
                    elif kl == "read list":
                        shares[cur]["read_list"] = parse_smb_token_list(v)
                    elif kl == "invalid users":
                        shares[cur]["invalid_users"] = parse_smb_token_list(v)
    except Exception:
        pass
    return shares


def list_dir(payload):
    full, norm = safe_join(payload.get("path", "/"))
    show_hidden = bool(payload.get("show_hidden", False))
    if not os.path.isdir(full):
        return {"ok": False, "error": "Pasta nao encontrada: " + norm}

    smb_shares = parse_smb_shares() if norm == "/" else {}
    items = []
    for name in sorted(os.listdir(full)):
        if norm == "/" and not show_hidden:
            if name.startswith(".") or name in HIDDEN_SYSTEM_NAMES:
                continue
        elif not show_hidden and name.startswith("."):
            continue
        p = os.path.join(full, name)
        try:
            st = os.lstat(p)
        except Exception:
            continue
        is_dir = os.path.isdir(p)
        uname = u_str(name)
        ext = "" if is_dir else (os.path.splitext(uname)[1].lstrip(".").lower())
        item_rel = (u"" if norm == "/" else norm) + u"/" + uname
        items.append({
            "name": uname,
            "path": item_rel,
            "is_dir": is_dir,
            "is_share": (norm == "/" and is_dir and (uname in smb_shares or not uname.startswith("."))),
            "ext": ext,
            "size": 0 if is_dir else int(st.st_size),
            "mtime": int(st.st_mtime),
            "mode": mode_str(st.st_mode, is_dir)
        })
    return {"ok": True, "path": norm, "items": items}


def register_samba_share(name, comment="Pasta criada pelo ServLynx"):
    name_b = b_str(name)
    comment_b = b_str(comment)
    target_dir = os.path.join(BASE_SHARE_DIR, name_b)
    if not os.path.exists(target_dir):
        os.makedirs(target_dir, 0o770)
    os.chmod(target_dir, 0o770)
    link_path = os.path.join("/share", name_b)
    if not os.path.exists(link_path):
        try:
            os.symlink(target_dir, link_path)
        except Exception:
            pass
    if os.path.exists("/sbin/setcfg"):
        conf = "/etc/config/smb.conf"
        cmds = [
            ["/sbin/setcfg", name_b, "comment", comment_b, "-f", conf],
            ["/sbin/setcfg", name_b, "path", target_dir, "-f", conf],
            ["/sbin/setcfg", name_b, "browsable", "yes", "-f", conf],
            ["/sbin/setcfg", name_b, "oplocks", "yes", "-f", conf],
            ["/sbin/setcfg", name_b, "writable", "yes", "-f", conf],
            ["/sbin/setcfg", name_b, "public", "no", "-f", conf],
            ["/sbin/setcfg", name_b, "valid users", '"root","admin"', "-f", conf],
            ["/sbin/setcfg", name_b, "write list", '"admin"', "-f", conf],
            ["/sbin/setcfg", name_b, "inherit permissions", "yes", "-f", conf]
        ]
        for c in cmds:
            run_cmd(c)
        run_cmd(["/etc/init.d/smb.sh", "reload"])


def handle_mkdir(payload):
    parent_full, parent_norm = safe_join(payload.get("path", "/"))
    name_b = b_str(payload.get("name") or "").strip()
    if not name_b or "/" in name_b or "\\" in name_b:
        return {"ok": False, "error": "Nome de pasta invalido"}
    target = os.path.join(parent_full, name_b)
    if os.path.exists(target):
        return {"ok": False, "error": "Ja existe uma pasta ou arquivo com este nome"}
    os.makedirs(target, 0o770)
    os.chmod(target, 0o770)
    if parent_norm == "/" and payload.get("register_share"):
        register_samba_share(name_b)
    return {"ok": True, "path": (u"" if parent_norm == "/" else parent_norm) + u"/" + u_str(name_b)}


def handle_touch(payload):
    parent_full, parent_norm = safe_join(payload.get("path", "/"))
    name_b = b_str(payload.get("name") or "").strip()
    content = payload.get("content", "")
    if not name_b or "/" in name_b or "\\" in name_b:
        return {"ok": False, "error": "Nome invalido"}
    target = os.path.join(parent_full, name_b)
    with open(target, "wb") as f:
        f.write(b_str(content))
    return {"ok": True}


def handle_rename(payload):
    src_full, src_norm = safe_join(payload.get("path", ""))
    new_name_b = b_str(payload.get("new_name") or "").strip()
    if not os.path.exists(src_full) or not new_name_b or "/" in new_name_b:
        return {"ok": False, "error": "Origem ou novo nome invalido"}
    dst_full = os.path.join(os.path.dirname(src_full), new_name_b)
    if os.path.exists(dst_full):
        return {"ok": False, "error": "Ja existe um item com esse nome"}
    os.rename(src_full, dst_full)
    return {"ok": True}


def handle_copy_or_move(action, payload):
    dest_full, dest_norm = safe_join(payload.get("dest", "/"))
    if not os.path.isdir(dest_full):
        return {"ok": False, "error": "Pasta de destino invalida"}
    deny_set = _normalize_deny_paths(payload.get("deny_paths"))
    if _is_rel_denied(dest_norm, deny_set):
        return {"ok": False, "error": "Pasta de destino com acesso restrito"}
    for s in payload.get("sources", []):
        src_full, src_norm = safe_join(s)
        if not os.path.exists(src_full):
            continue
        if _has_denied_descendant(src_norm, deny_set):
            return {"ok": False, "error": "Pasta contem subpastas com acesso restrito"}
        dst = os.path.join(dest_full, os.path.basename(src_full))
        if action == "copy":
            if os.path.isdir(src_full):
                if os.path.exists(dst):
                    dst = dst + "_copia"
                shutil.copytree(src_full, dst)
            else:
                shutil.copy2(src_full, dst)
        else:
            shutil.move(src_full, dst)
    return {"ok": True}


def handle_delete(payload):
    for p in payload.get("paths", []):
        full, norm = safe_join(p)
        if norm == "/" or not os.path.exists(full):
            continue
        if os.path.isdir(full):
            shutil.rmtree(full)
        else:
            os.remove(full)
    return {"ok": True}


def handle_read_text(payload):
    full, _ = safe_join(payload.get("path", ""))
    if not os.path.isfile(full):
        return {"ok": False, "error": "Arquivo nao encontrado"}
    if os.path.getsize(full) > 2 * 1024 * 1024:
        return {"ok": False, "error": "Arquivo muito grande para edicao direta (max 2MB)"}
    with open(full, "rb") as f:
        raw = f.read()
    return {"ok": True, "content": raw.decode("utf-8", "replace")}


def handle_write_text(payload):
    full, _ = safe_join(payload.get("path", ""))
    content = payload.get("content", "")
    with open(full, "wb") as f:
        f.write(b_str(content))
    return {"ok": True}


def handle_search(payload):
    base_full, base_norm = safe_join(payload.get("path", "/"))
    query = u_str(payload.get("query") or "").strip().lower()
    results = []
    if not query or not os.path.isdir(base_full):
        return {"ok": True, "items": []}
    for root, dirs, files in os.walk(base_full):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in HIDDEN_SYSTEM_NAMES]
        for name in dirs + files:
            if name.startswith("."):
                continue
            uname = u_str(name)
            if query in uname.lower():
                p = os.path.join(root, name)
                try:
                    st = os.lstat(p)
                    is_dir = os.path.isdir(p)
                    rel = u_str(os.path.relpath(p, BASE_SHARE_DIR)).replace("\\", "/")
                    results.append({
                        "name": uname,
                        "path": u"/" + rel,
                        "is_dir": is_dir,
                        "ext": "" if is_dir else os.path.splitext(uname)[1].lstrip(".").lower(),
                        "size": 0 if is_dir else int(st.st_size),
                        "mtime": int(st.st_mtime),
                        "mode": mode_str(st.st_mode, is_dir)
                    })
                except Exception:
                    pass
                if len(results) >= 150:
                    return {"ok": True, "items": results}
    return {"ok": True, "items": results}


def handle_properties(payload):
    full, norm = safe_join(payload.get("path", "/"))
    if not os.path.exists(full):
        return {"ok": False, "error": "Caminho nao encontrado"}
    total_size = 0
    files_cnt = 0
    dirs_cnt = 0
    if os.path.isfile(full):
        total_size = os.path.getsize(full)
        files_cnt = 1
    else:
        for root, dirs, files in os.walk(full):
            dirs_cnt += len(dirs)
            for fn in files:
                files_cnt += 1
                try:
                    total_size += os.path.getsize(os.path.join(root, fn))
                except Exception:
                    pass
    st = os.lstat(full)
    return {
        "ok": True,
        "properties": {
            "path": norm,
            "size": total_size,
            "size_human": human_size(total_size),
            "files_count": files_cnt,
            "dirs_count": dirs_cnt,
            "mode": mode_str(st.st_mode, os.path.isdir(full)),
            "owner": "admin"
        }
    }


def handle_upload_pull(payload):
    up_id = b_str(payload.get("up_id", ""))
    filename = os.path.basename(b_str(payload.get("filename") or "arquivo.bin").replace("\\", "/"))
    dest_dir, _ = safe_join(payload.get("target_path", "/"))
    if not os.path.isdir(dest_dir):
        return {"ok": False, "error": "Pasta destino inexistente"}
    dest_file = os.path.join(dest_dir, filename)
    url = "%s?route=bridge_get_upload&id=%s" % (API_URL, urlquote(up_id))
    rc, _, err = run_cmd([
        CURL_BIN, "-sk", "--max-time", "55",
        "-H", "X-Bridge-Secret: " + BRIDGE_SECRET,
        url, "-o", dest_file
    ])
    if rc != 0:
        return {"ok": False, "error": "Falha ao baixar upload para QNAP: " + err}
    return {"ok": True, "path": u_str(dest_file)}


EXT_MIME_MAP = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "heic": "image/heic",
    "heif": "image/heif",
    "avif": "image/avif",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "opus": "audio/opus",
    "wma": "audio/x-ms-wma",
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "webm": "video/webm",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska",
    "avi": "video/x-msvideo",
    "3gp": "video/3gpp",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "xml": "application/xml; charset=utf-8"
}


def handle_download_push(payload):
    dl_id = b_str(payload.get("dl_id", ""))
    full, norm = safe_join(payload.get("path", ""))
    if not os.path.exists(full):
        return {"ok": False, "error": "Arquivo ou pasta nao encontrada"}
    deny_set = _normalize_deny_paths(payload.get("deny_paths"))
    if _is_rel_denied(norm, deny_set):
        return {"ok": False, "error": "Acesso negado a este caminho"}
    tmp_zip = None
    send_file = full
    filename = os.path.basename(full)
    if os.path.isdir(full):
        tmp_zip = "/tmp/slx_%s.zip" % dl_id
        with zipfile.ZipFile(tmp_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(full):
                rel_dir = os.path.relpath(root, full)
                rel_dir_u = u_str(rel_dir).replace("\\", "/")
                cur_norm = norm if rel_dir_u in (".", "") else (norm.rstrip("/") + "/" + rel_dir_u.strip("/"))
                if _is_rel_denied(cur_norm, deny_set):
                    dirs[:] = []
                    continue
                dirs[:] = [
                    d for d in dirs
                    if not b_str(d).startswith(".")
                    and not _is_rel_denied(cur_norm.rstrip("/") + "/" + u_str(d), deny_set)
                ]
                for fn in files:
                    fp = os.path.join(root, fn)
                    arc = os.path.relpath(fp, os.path.dirname(full))
                    try:
                        zf.write(fp, arc)
                    except Exception:
                        pass
        send_file = tmp_zip
        filename = filename + ".zip"
        mime = "application/zip"
    else:
        ext = os.path.splitext(filename)[1].lstrip(".").lower()
        mime = EXT_MIME_MAP.get(ext) or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    try:
        st = os.stat(send_file)
        fsize = int(st.st_size)
        fmtime = int(st.st_mtime)
    except Exception:
        fsize = 0
        fmtime = int(time.time())

    url = "%s?route=bridge_put_download&id=%s" % (API_URL, urlquote(dl_id))
    rc, _, err = run_cmd([
        CURL_BIN, "-sk", "--max-time", "55", "-X", "POST",
        "-H", "X-Bridge-Secret: " + BRIDGE_SECRET,
        "--data-binary", "@" + send_file,
        url
    ])
    if tmp_zip and os.path.exists(tmp_zip):
        try:
            os.remove(tmp_zip)
        except Exception:
            pass
    if rc != 0:
        return {"ok": False, "error": "Erro ao enviar arquivo para gateway: " + err}
    return {"ok": True, "filename": u_str(filename), "mime": mime, "size": fsize, "mtime": fmtime}


def get_qnap_status():
    st = {"model": "TS-231P", "hostname": "NAS09534B", "firmware": "4.3.6", "ip": "192.168.15.44", "mac": "24:5E:BE:09:53:4B"}
    try:
        rc, out, _ = run_cmd(["/sbin/getcfg", "System", "Version"])
        if rc == 0 and out.strip():
            st["firmware"] = out.strip()
    except Exception:
        pass
    try:
        with open("/proc/loadavg") as f:
            st["cpu_load"] = " ".join(f.read().split()[:3])
    except Exception:
        st["cpu_load"] = "--"
    try:
        with open("/proc/uptime") as f:
            secs = int(float(f.read().split()[0]))
            hrs = secs // 3600
            mins = (secs % 3600) // 60
            st["uptime"] = "%dh %dm" % (hrs, mins)
    except Exception:
        st["uptime"] = "--"
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k.strip()] = int(v.strip().split()[0])
        tot = mem.get("MemTotal", 1024000)
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        used = tot - avail
        st["memory"] = {
            "total_mb": tot // 1024,
            "used_mb": used // 1024,
            "percent": int(round((used * 100.0) / max(1, tot)))
        }
    except Exception:
        pass
    try:
        sv = os.statvfs(BASE_SHARE_DIR)
        tot = sv.f_blocks * sv.f_frsize
        avail = sv.f_bavail * sv.f_frsize
        used = tot - (sv.f_bfree * sv.f_frsize)
        st["disk"] = {
            "total": tot,
            "used": used,
            "avail": avail,
            "total_human": human_size(tot),
            "used_human": human_size(used),
            "avail_human": human_size(avail),
            "percent": int(round((used * 100.0) / max(1, tot)))
        }
    except Exception:
        pass

    disks = []
    for bay in (1, 2):
        rc, t, _ = run_cmd(["/sbin/get_hd_temp", str(bay)])
        temp = t.strip() if rc == 0 and t.strip().isdigit() else "--"
        disks.append({
            "bay": bay,
            "dev": "/dev/sda" if bay == 1 else "/dev/sdb",
            "model": "WDC WD20EFRX-68EUZN0",
            "size": "1.82 TB",
            "temp": temp
        })
    st["physical_disks"] = disks
    st["raid_summary"] = "/dev/md1 (RAID 1 Espelhamento Ativo)"

    _, ps_out, _ = run_cmd(["ps"])
    st["services"] = {
        "smb": "smbd" in ps_out,
        "ssh": "sshd" in ps_out,
        "web": "thttpd" in ps_out or "_thttpd_" in ps_out
    }
    return st


def _share_everyone_mode(info):
    v_users = info.get("valid_users") or []
    w_list = info.get("write_list") or []
    r_list = info.get("read_list") or []
    inv_list = info.get("invalid_users") or []
    if "@everyone" in inv_list:
        return "none"
    if "@everyone" in v_users:
        if "@everyone" in w_list or ("@everyone" not in r_list and not r_list and not w_list):
            return "rw"
        if "@everyone" in r_list:
            return "ro"
        return "rw" if "@everyone" not in r_list else "ro"
    return "none"


def handle_list_shares():
    smb = parse_smb_shares()
    root_res = list_dir({"path": "/", "show_hidden": False})
    shares = []
    seen = set()
    for it in root_res.get("items", []):
        name = it["name"]
        seen.add(name)
        info = smb.get(name, {})
        shares.append({
            "name": name,
            "nas_path": os.path.join(BASE_SHARE_DIR, name),
            "comment": info.get("comment", ""),
            "size_human": "--",
            "is_smb": (name in smb),
            "public": (info.get("public", "") == "yes"),
            "valid_users": info.get("valid_users", []),
            "write_list": info.get("write_list", []),
            "read_list": info.get("read_list", []),
            "invalid_users": info.get("invalid_users", []),
            "everyone_access": _share_everyone_mode(info)
        })
    for name, info in smb.items():
        if name not in seen and name.lower() not in ("home", "homes"):
            shares.append({
                "name": name,
                "nas_path": info.get("path", os.path.join(BASE_SHARE_DIR, name)),
                "comment": info.get("comment", ""),
                "size_human": "--",
                "is_smb": True,
                "public": (info.get("public", "") == "yes"),
                "valid_users": info.get("valid_users", []),
                "write_list": info.get("write_list", []),
                "read_list": info.get("read_list", []),
                "invalid_users": info.get("invalid_users", []),
                "everyone_access": _share_everyone_mode(info)
            })
    return {"ok": True, "shares": shares}


def handle_create_share(payload):
    name = (payload.get("name") or "").strip()
    comment = (payload.get("comment") or "Pasta ServLynx").strip()
    if not name or not re.match(r"^[a-zA-Z0-9_\-\s]{2,40}$", name):
        return {"ok": False, "error": "Nome de compartilhamento invalido"}
    register_samba_share(name, comment)
    return {"ok": True, "name": name}


def handle_delete_share(payload):
    name = (payload.get("name") or "").strip()
    if not name or name in ("Public", "Web", "Download", "Multimedia", "homes"):
        return {"ok": False, "error": "Compartilhamento protegido do sistema QNAP"}
    conf = "/etc/config/smb.conf"
    if os.path.exists("/sbin/rmcfg"):
        run_cmd(["/sbin/rmcfg", name, "-f", conf])
    elif os.path.exists(conf):
        with open(conf, "r") as f:
            lines = f.readlines()
        out = []
        skip = False
        for ln in lines:
            st = ln.strip()
            if st.startswith("[") and st.endswith("]"):
                skip = (st[1:-1].strip() == name)
            if not skip:
                out.append(ln)
        with open(conf, "w") as f:
            f.writelines(out)
    run_cmd(["/etc/init.d/smb.sh", "reload"])
    if payload.get("delete_data"):
        target = os.path.join(BASE_SHARE_DIR, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
    return {"ok": True}


def _read_qnap_groups():
    groups = {}
    try:
        with open("/etc/group", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) < 4:
                    continue
                gname = parts[0].strip()
                members = [m.strip() for m in parts[3].split(",") if m.strip()]
                groups[gname] = members
    except Exception:
        pass
    return groups


def _compute_user_share_access(uname, is_admin, share_info):
    if uname == "admin":
        return "rw"
    if not share_info.get("is_smb", True):
        return "none"
    v_users = share_info.get("valid_users") or []
    w_list = share_info.get("write_list") or []
    r_list = share_info.get("read_list") or []
    inv_list = share_info.get("invalid_users") or []

    user_groups = ["everyone"]
    if is_admin:
        user_groups.append("administrators")
    group_tokens = ["@" + g for g in user_groups]

    if uname in inv_list or any(gt in inv_list for gt in group_tokens):
        return "none"

    is_valid = (
        uname in v_users
        or any(gt in v_users for gt in group_tokens)
        or (len(v_users) == 0 and share_info.get("public"))
    )
    if not is_valid:
        return "none"

    if uname in w_list:
        return "rw"
    if uname in r_list:
        return "ro"
    if any(gt in w_list for gt in group_tokens):
        return "rw"
    if any(gt in r_list for gt in group_tokens):
        return "ro"
    # Valid user when share is writable and not restricted to read_list
    if len(r_list) == 0:
        return "rw"
    return "ro"


def handle_list_qnap_users():
    groups = _read_qnap_groups()
    admin_members = set(groups.get("administrators", []))
    shares_res = handle_list_shares()
    shares_list = shares_res.get("shares", [])
    users = []
    try:
        with open("/etc/passwd", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) < 7:
                    continue
                uname, _, uid, gid = parts[0], parts[1], int(parts[2]), int(parts[3])
                gecos = parts[4].strip() if len(parts) > 4 else ""
                if uname == "admin" or (500 <= uid < 65000):
                    is_admin = (uname == "admin" or gid == 0 or uname in admin_members)
                    access_map = {}
                    for sh in shares_list:
                        access_map[sh["name"]] = _compute_user_share_access(uname, is_admin, sh)
                    gecos_items = [x.strip() for x in gecos.split(",") if x.strip() and x.strip() != "Linux User"]
                    users.append({
                        "username": uname,
                        "uid": uid,
                        "group": "administrators" if is_admin else "everyone",
                        "is_admin": is_admin,
                        "comment": gecos_items[0] if gecos_items else "",
                        "share_access": access_map
                    })
    except Exception:
        pass
    return {"ok": True, "users": users}


def handle_create_qnap_user(payload):
    uname = re.sub(r"[^a-zA-Z0-9_]", "", (payload.get("username") or "").strip())[:30]
    pw = payload.get("password") or ""
    is_admin = bool(payload.get("is_admin", False))
    ensure_only = bool(payload.get("ensure_only", False))
    if not uname or uname.lower() in ("root", "guest", "httpdusr") or (uname.lower() == "admin" and not ensure_only):
        return {"ok": False, "error": "Nome de usuario reservado ou invalido para o QNAP"}
    if not ensure_only and len(pw) < 4:
        return {"ok": False, "error": "Usuario ou senha invalida para QNAP (minimo 4 caracteres)"}

    if not os.path.exists("/share/homes"):
        try:
            os.makedirs("/share/homes", 0o755)
        except Exception:
            pass

    home_dir = "/share/homes/" + uname
    grp = "administrators" if is_admin else "everyone"
    # Verifica se usuario ja existe
    rc, _, _ = run_cmd(["id", uname])
    if rc != 0:
        rc_add, out_add, err_add = run_cmd(["/bin/adduser", "-D", "-h", home_dir, "-G", grp, uname])
        if rc_add != 0:
            err_msg = (err_add or out_add or "erro no adduser").strip()
            return {"ok": False, "error": "Falha ao criar usuario no QNAP: " + err_msg}

    if not os.path.exists(home_dir):
        try:
            os.makedirs(home_dir, 0o755)
        except Exception:
            pass

    if uname != "admin":
        _update_qnap_admin_group(uname, is_admin)

    # Define senha Linux e Samba sempre que uma senha valida for enviada
    if len(pw) >= 4:
        pw_input = ("%s\n%s\n" % (pw, pw)).encode("utf-8")
        run_cmd(["passwd", uname], input_data=pw_input)
        smb_bin = "/usr/local/samba/bin/smbpasswd"
        if os.path.exists(smb_bin):
            run_cmd([smb_bin, "-a", "-s", uname], input_data=pw_input)

    return {"ok": True, "username": uname, "existed": (rc == 0), "is_admin": is_admin}


def handle_change_qnap_password(payload):
    uname = re.sub(r"[^a-zA-Z0-9_]", "", (payload.get("username") or "").strip())
    pw = payload.get("password") or ""
    if not uname or len(pw) < 4:
        return {"ok": False, "error": "Dados invalidos"}
    pw_input = ("%s\n%s\n" % (pw, pw)).encode("utf-8")
    run_cmd(["passwd", uname], input_data=pw_input)
    smb_bin = "/usr/local/samba/bin/smbpasswd"
    if os.path.exists(smb_bin):
        run_cmd([smb_bin, "-s", uname], input_data=pw_input)
    return {"ok": True}


def handle_delete_qnap_user(payload):
    uname = re.sub(r"[^a-zA-Z0-9_]", "", (payload.get("username") or "").strip())
    if not uname or uname in ("admin", "guest", "httpdusr"):
        return {"ok": False, "error": "Nao e possivel remover este usuario do sistema"}
    smb_bin = "/usr/local/samba/bin/smbpasswd"
    if os.path.exists(smb_bin):
        run_cmd([smb_bin, "-x", uname])
    run_cmd(["/bin/deluser", uname])
    _update_qnap_admin_group(uname, False)

    # Limpa eventuais entradas do usuario nas ACLs Samba
    smb_all = parse_smb_shares()
    cleaned_acl = False
    for sh_b, info in smb_all.items():
        v_users = list(info.get("valid_users") or [])
        w_list = list(info.get("write_list") or [])
        r_list = list(info.get("read_list") or [])
        inv_list = list(info.get("invalid_users") or [])
        if uname in v_users or uname in w_list or uname in r_list or uname in inv_list:
            v_users, w_list, r_list, inv_list = _apply_token_mode(
                v_users, w_list, r_list, inv_list, uname, "none", protect_via_invalid=False
            )
            _save_smb_share_acl(sh_b, v_users, w_list, r_list, inv_list, reload_smb=False)
            cleaned_acl = True
    if cleaned_acl:
        run_cmd(["/etc/init.d/smb.sh", "reload"])
    return {"ok": True}


def handle_qnap_action(payload):
    act = payload.get("action", "")
    if act == "beep":
        run_cmd(["/sbin/hal_app", "--se_buzzer", "enc_id=0,mode=1"])
        return {"ok": True}
    if act == "restart_smb":
        run_cmd(["/etc/init.d/smb.sh", "restart"])
        return {"ok": True}
    return {"ok": False, "error": "Acao desconhecida"}


def _format_smb_tokens(tokens):
    out = []
    seen = set()
    for t in tokens:
        s = b_str(t).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        if s.startswith("@"):
            g = s[1:].strip('"\' ')
            out.append('@"%s"' % g)
        else:
            u = s.strip('"\' ')
            out.append('"%s"' % u)
    return ",".join(out)


def _ensure_token(lst, tok):
    if tok not in lst:
        lst.append(tok)


def _remove_token(lst, tok):
    return [x for x in lst if x != tok]


def _save_smb_share_acl(share_name, valid_users, write_list, read_list, invalid_users, comment=None, reload_smb=True):
    name_b = b_str(share_name).strip()
    if not name_b or not os.path.exists("/sbin/setcfg"):
        return False, "setcfg indisponivel ou pasta invalida"

    conf = "/etc/config/smb.conf"
    smb_all = parse_smb_shares()
    target_dir = os.path.join(BASE_SHARE_DIR, name_b)
    if name_b not in smb_all:
        if not os.path.exists(target_dir):
            os.makedirs(target_dir, 0o770)
        register_samba_share(name_b, b_str(comment) if comment is not None else "Pasta ServLynx")

    # Garante sempre acesso administrativo ao root e admin
    _ensure_token(valid_users, "root")
    _ensure_token(valid_users, "admin")
    _ensure_token(write_list, "admin")
    read_list = _remove_token(read_list, "admin")
    read_list = _remove_token(read_list, "root")
    invalid_users = _remove_token(invalid_users, "admin")
    invalid_users = _remove_token(invalid_users, "root")

    cmds = [
        ["/sbin/setcfg", name_b, "writable", "yes", "-f", conf],
        ["/sbin/setcfg", name_b, "public", "no", "-f", conf],
        ["/sbin/setcfg", name_b, "valid users", _format_smb_tokens(valid_users), "-f", conf],
        ["/sbin/setcfg", name_b, "write list", _format_smb_tokens(write_list), "-f", conf],
        ["/sbin/setcfg", name_b, "read list", _format_smb_tokens(read_list), "-f", conf],
        ["/sbin/setcfg", name_b, "invalid users", _format_smb_tokens(invalid_users), "-f", conf]
    ]
    if comment is not None:
        cmds.append(["/sbin/setcfg", name_b, "comment", b_str(comment).strip(), "-f", conf])

    for c in cmds:
        run_cmd(c)
    if reload_smb:
        run_cmd(["/etc/init.d/smb.sh", "reload"])
    return True, None


def _apply_token_mode(valid_users, write_list, read_list, invalid_users, token, mode, protect_via_invalid=False):
    valid_users = _remove_token(valid_users, token)
    write_list = _remove_token(write_list, token)
    read_list = _remove_token(read_list, token)
    invalid_users = _remove_token(invalid_users, token)
    if mode == "rw":
        _ensure_token(valid_users, token)
        _ensure_token(write_list, token)
    elif mode == "ro":
        _ensure_token(valid_users, token)
        _ensure_token(read_list, token)
    elif mode == "none" and protect_via_invalid:
        _ensure_token(invalid_users, token)
    return valid_users, write_list, read_list, invalid_users


def _update_qnap_admin_group(uname, is_admin):
    if not uname or uname == "admin" or is_admin is None:
        return
    try:
        with open("/etc/group", "r") as f:
            lines = f.readlines()
        new_lines = []
        changed = False
        for line in lines:
            if line.startswith("administrators:"):
                parts = line.rstrip("\n").split(":")
                if len(parts) >= 4:
                    members = [m.strip() for m in parts[3].split(",") if m.strip()]
                    if is_admin:
                        if uname not in members:
                            members.append(uname)
                            changed = True
                    else:
                        if uname in members and uname != "admin":
                            members = [m for m in members if m != uname]
                            changed = True
                    if "admin" not in members:
                        members.insert(0, "admin")
                    new_lines.append("%s:%s:%s:%s\n" % (parts[0], parts[1], parts[2], ",".join(members)))
                    continue
            new_lines.append(line)
        if changed:
            with open("/etc/group", "w") as f:
                f.writelines(new_lines)
    except Exception:
        pass


def handle_set_qnap_user_access(payload):
    uname = re.sub(r"[^a-zA-Z0-9_]", "", (payload.get("username") or "").strip())
    if not uname:
        return {"ok": False, "error": "Usuario QNAP invalido"}
    rc, _, _ = run_cmd(["id", uname])
    if rc != 0:
        return {"ok": False, "error": "Usuario QNAP nao encontrado: " + uname}

    if payload.get("is_admin") is not None and uname != "admin":
        _update_qnap_admin_group(uname, bool(payload.get("is_admin")))

    share_access = payload.get("share_access") or {}
    if not isinstance(share_access, dict):
        return {"ok": False, "error": "Formato share_access invalido"}

    smb_all = parse_smb_shares()
    groups = _read_qnap_groups()
    user_is_admin = (uname == "admin" or uname in groups.get("administrators", []))

    updated_count = 0
    for sh_name, raw_mode in share_access.items():
        sh_b = b_str(sh_name).strip()
        if not sh_b:
            continue
        # Impede travamento do usuario admin
        mode = "rw" if uname == "admin" else (str(raw_mode or "none").lower())
        if mode not in ("rw", "ro", "none"):
            mode = "none"

        info = smb_all.get(sh_b, {})
        v_users = list(info.get("valid_users") or [])
        w_list = list(info.get("write_list") or [])
        r_list = list(info.get("read_list") or [])
        inv_list = list(info.get("invalid_users") or [])

        has_group_grant = ("@everyone" in v_users) or (user_is_admin and "@administrators" in v_users)
        v_users, w_list, r_list, inv_list = _apply_token_mode(
            v_users, w_list, r_list, inv_list, uname, mode, protect_via_invalid=has_group_grant
        )
        ok, err = _save_smb_share_acl(sh_b, v_users, w_list, r_list, inv_list, reload_smb=False)
        if not ok:
            return {"ok": False, "error": err or "Falha ao atualizar ACL"}
        updated_count += 1

    if updated_count > 0:
        run_cmd(["/etc/init.d/smb.sh", "reload"])
    return {"ok": True, "username": uname, "updated_shares": updated_count}


def handle_set_share_access(payload):
    sh_name = b_str(payload.get("name") or "").strip()
    if not sh_name or "/" in sh_name or ".." in sh_name:
        return {"ok": False, "error": "Nome de pasta compartilhada invalido"}

    smb_all = parse_smb_shares()
    info = smb_all.get(sh_name, {})
    v_users = list(info.get("valid_users") or [])
    w_list = list(info.get("write_list") or [])
    r_list = list(info.get("read_list") or [])
    inv_list = list(info.get("invalid_users") or [])

    ev_access = payload.get("everyone_access")
    if ev_access in ("rw", "ro", "none"):
        v_users, w_list, r_list, inv_list = _apply_token_mode(
            v_users, w_list, r_list, inv_list, "@everyone", ev_access, protect_via_invalid=False
        )

    qnap_access = payload.get("qnap_access") or {}
    groups = _read_qnap_groups()
    admin_members = set(groups.get("administrators", []))

    if isinstance(qnap_access, dict):
        for raw_u, raw_mode in qnap_access.items():
            uname = re.sub(r"[^a-zA-Z0-9_]", "", str(raw_u).strip())
            if not uname or uname in ("root", "admin"):
                continue
            mode = str(raw_mode or "none").lower()
            if mode not in ("rw", "ro", "none"):
                mode = "none"
            has_group_grant = ("@everyone" in v_users) or (uname in admin_members and "@administrators" in v_users)
            v_users, w_list, r_list, inv_list = _apply_token_mode(
                v_users, w_list, r_list, inv_list, uname, mode, protect_via_invalid=has_group_grant
            )

    comment = payload.get("comment")
    ok, err = _save_smb_share_acl(sh_name, v_users, w_list, r_list, inv_list, comment=comment, reload_smb=True)
    if not ok:
        return {"ok": False, "error": err or "Falha ao atualizar permissao da pasta"}
    return {
        "ok": True,
        "name": sh_name,
        "valid_users": v_users,
        "write_list": w_list,
        "read_list": r_list,
        "invalid_users": inv_list
    }


def dispatch_task(task):
    action = task.get("action")
    payload = task.get("payload") or {}
    try:
        if action == "list_dir":
            return list_dir(payload)
        if action == "mkdir":
            return handle_mkdir(payload)
        if action == "touch":
            return handle_touch(payload)
        if action == "rename":
            return handle_rename(payload)
        if action in ("copy", "move"):
            return handle_copy_or_move(action, payload)
        if action == "delete":
            return handle_delete(payload)
        if action == "read_text":
            return handle_read_text(payload)
        if action == "write_text":
            return handle_write_text(payload)
        if action == "search":
            return handle_search(payload)
        if action == "properties":
            return handle_properties(payload)
        if action == "upload_pull":
            return handle_upload_pull(payload)
        if action == "download_push":
            return handle_download_push(payload)
        if action == "qnap_status":
            return {"ok": True, "status": get_qnap_status()}
        if action == "list_shares":
            return handle_list_shares()
        if action == "create_share":
            return handle_create_share(payload)
        if action == "delete_share":
            return handle_delete_share(payload)
        if action == "set_share_access":
            return handle_set_share_access(payload)
        if action == "list_qnap_users":
            return handle_list_qnap_users()
        if action == "create_qnap_user":
            return handle_create_qnap_user(payload)
        if action == "change_qnap_password":
            return handle_change_qnap_password(payload)
        if action == "delete_qnap_user":
            return handle_delete_qnap_user(payload)
        if action == "set_qnap_user_access":
            return handle_set_qnap_user_access(payload)
        if action == "qnap_action":
            return handle_qnap_action(payload)
        return {"ok": False, "error": "Acao nao suportada: " + str(action)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def push_initial_state():
    try:
        root_res = list_dir({"path": "/", "show_hidden": False})
        shares_res = handle_list_shares()
        st = get_qnap_status()
        curl_json("bridge_push_state", {
            "agent": AGENT_ID,
            "qnap_status": st,
            "root_items": root_res.get("items", []),
            "shares": shares_res.get("shares", [])
        }, timeout=15)
        log("Estado inicial do QNAP sincronizado com servlynx.lynxems.com.br")
    except Exception as exc:
        log("Aviso ao sincronizar estado inicial: " + str(exc))


_LOCK_FP = None


def acquire_single_instance_lock():
    """Ensure only one qnap_bridge daemon runs at a time using kernel flock."""
    global _LOCK_FP
    lock_path = "/tmp/servlynx_qnap_bridge.lock"
    pid_path = "/share/CACHEDEV1_DATA/.servlynx/bridge.pid"
    _LOCK_FP = open(lock_path, "a+")
    try:
        fcntl.flock(_LOCK_FP.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        sys.exit(0)
    _LOCK_FP.seek(0)
    _LOCK_FP.truncate()
    _LOCK_FP.write(str(os.getpid()) + "\n")
    _LOCK_FP.flush()
    try:
        with open(pid_path, "w") as pf:
            pf.write(str(os.getpid()) + "\n")
    except Exception:
        pass


def daemonize(log_file):
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        if os.path.exists(log_file) and os.path.getsize(log_file) > 2 * 1024 * 1024:
            old_log = log_file + ".old"
            if os.path.exists(old_log):
                os.remove(old_log)
            os.rename(log_file, old_log)
    except Exception:
        pass
    si = open("/dev/null", "r")
    so = open(log_file, "a+", 0)
    os.dup2(si.fileno(), sys.stdin.fileno())
    os.dup2(so.fileno(), sys.stdout.fileno())
    os.dup2(so.fileno(), sys.stderr.fileno())


def main():
    if "--daemon" in sys.argv:
        daemonize("/share/CACHEDEV1_DATA/.servlynx/bridge.log")
    acquire_single_instance_lock()
    log("Iniciando ServLynx QNAP Native Bridge Agent (PID %d)..." % os.getpid())
    push_initial_state()
    last_state_push = time.time()

    while True:
        try:
            res = curl_json("bridge_poll", query="wait=11&agent=" + AGENT_ID, timeout=18)
            for task in res.get("tasks", []):
                tid = task.get("id")
                log("Executando tarefa [%s]: %s" % (tid, task.get("action")))
                result = dispatch_task(task)
                curl_json("bridge_reply", {"id": tid, "result": result}, timeout=15)

            if time.time() - last_state_push > 45:
                push_initial_state()
                last_state_push = time.time()
        except Exception as exc:
            log("Erro no loop bridge: " + str(exc))
            time.sleep(3)


if __name__ == "__main__":
    main()
