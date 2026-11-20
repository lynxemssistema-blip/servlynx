<?php
/**
 * ServLynx Explorer & QNAP Manager - Biblioteca Compartilhada (Gateway API & WebDAV)
 */

@set_time_limit(60);
@ini_set('memory_limit', '256M');
@ini_set('upload_max_filesize', '256M');
@ini_set('post_max_size', '256M');

date_default_timezone_set('America/Sao_Paulo');

define('DATA_DIR', __DIR__ . '/data');
define('QUEUE_DIR', DATA_DIR . '/queue');
define('RESP_DIR', DATA_DIR . '/responses');
define('UPLOAD_DIR', DATA_DIR . '/uploads');
define('DOWNLOAD_DIR', DATA_DIR . '/downloads');
define('USERS_FILE', DATA_DIR . '/users.json');
define('SESSIONS_FILE', DATA_DIR . '/sessions.json');
define('STATE_FILE', DATA_DIR . '/state.json');
define('BRIDGE_LOG_FILE', DATA_DIR . '/bridge.log');
define('RESET_TOKENS_FILE', DATA_DIR . '/reset_tokens.json');
define('NOTIFY_CONFIG_FILE', DATA_DIR . '/notify_config.json');
define('RATE_LIMIT_FILE', DATA_DIR . '/rate_limit.json');

function slx_secret($key, $envName = '') {
    static $cfg = null;
    if ($cfg === null) {
        $file = __DIR__ . '/secrets.php';
        if (file_exists($file)) {
            $loaded = @include $file;
            $cfg = is_array($loaded) ? $loaded : [];
        } else {
            $cfg = [];
        }
    }
    if (isset($cfg[$key]) && $cfg[$key] !== '') {
        return (string)$cfg[$key];
    }
    if ($envName !== '') {
        $envVal = getenv($envName);
        if ($envVal !== false && $envVal !== '') {
            return (string)$envVal;
        }
    }
    return '';
}

// Chave compartilhada entre api.php e os agentes QNAP (bridge)
define('BRIDGE_SECRET', (string)slx_secret('bridge_secret', 'SERVLYNX_BRIDGE_SECRET'));

// Garante estrutura de pastas protegidas
foreach ([DATA_DIR, QUEUE_DIR, RESP_DIR, UPLOAD_DIR, DOWNLOAD_DIR] as $dir) {
    if (!is_dir($dir)) {
        @mkdir($dir, 0750, true);
    }
}
$dataHtaccess = DATA_DIR . '/.htaccess';
if (!file_exists($dataHtaccess)) {
    @file_put_contents($dataHtaccess, "Require all denied\nDeny from all\n");
}

function json_out($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function get_json_body() {
    $raw = file_get_contents('php://input');
    if (!$raw) return [];
    $dec = json_decode($raw, true);
    return is_array($dec) ? $dec : [];
}

function read_json_file($path, $default = []) {
    if (!file_exists($path)) return $default;
    $fp = @fopen($path, 'r');
    if (!$fp) return $default;
    @flock($fp, LOCK_SH);
    $content = stream_get_contents($fp);
    @flock($fp, LOCK_UN);
    @fclose($fp);
    if (!$content) return $default;
    $data = json_decode($content, true);
    return is_array($data) ? $data : $default;
}

function write_json_file($path, $data) {
    $tmp = $path . '.tmp.' . uniqid('', true);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (@file_put_contents($tmp, $json, LOCK_EX) !== false) {
        @rename($tmp, $path);
        return true;
    }
    return false;
}

function hash_password_portable($password, $salt = null) {
    return password_hash((string)$password, PASSWORD_DEFAULT);
}

function is_legacy_password_hash($stored) {
    $stored = (string)$stored;
    if ($stored === '') return true;
    if (strpos($stored, 'sha256$') === 0) return true;
    return password_needs_rehash($stored, PASSWORD_DEFAULT);
}

function verify_password_portable($password, $stored) {
    if (!$stored) return false;
    $parts = explode('$', $stored);
    if (count($parts) === 3 && $parts[0] === 'sha256') {
        $calc = hash('sha256', $parts[1] . ':' . $password);
        return hash_equals($parts[2], $calc);
    }
    return password_verify($password, $stored);
}

function encrypt_password_reversible($plainPassword) {
    $plain = (string)$plainPassword;
    if ($plain === '') return '';
    if (!function_exists('openssl_encrypt')) return '';
    $key = hash('sha256', BRIDGE_SECRET, true);
    $iv = random_bytes(16);
    $cipher = openssl_encrypt($plain, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
    if ($cipher === false) return '';
    return base64_encode($iv . $cipher);
}

function decrypt_password_reversible($enc) {
    if (!$enc || !is_string($enc)) return '';
    if (!function_exists('openssl_decrypt')) return '';
    $raw = base64_decode($enc, true);
    if ($raw === false || strlen($raw) <= 16) return '';
    $iv = substr($raw, 0, 16);
    $cipher = substr($raw, 16);
    $key = hash('sha256', BRIDGE_SECRET, true);
    $plain = openssl_decrypt($cipher, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
    return ($plain !== false) ? $plain : '';
}

function is_master_admin_user($u) {
    return ((string)($u['id'] ?? '')) === 'usr_master_edson';
}

function full_admin_permissions() {
    return [
        'read' => true,
        'write' => true,
        'delete' => true,
        'manage_users' => true,
        'manage_shares' => true,
        'manage_qnap' => true
    ];
}

function normalize_user_path_access($rawMap) {
    if (!is_array($rawMap)) return [];
    $out = [];
    foreach ($rawMap as $rawPath => $rawMode) {
        $norm = normalize_rel_path($rawPath);
        if ($norm === '/') continue;
        $mode = strtolower(trim((string)$rawMode));
        if (!in_array($mode, ['rw', 'ro', 'none'], true)) continue;
        $out[$norm] = $mode;
    }
    return $out;
}

function init_users_if_empty() {
    $users = read_json_file(USERS_FILE, null);
    $initPass = (string)slx_secret('master_init_pass', 'SERVLYNX_MASTER_INIT_PASS');
    if (!is_array($users) || count($users) === 0) {
        $seedPass = ($initPass !== '') ? $initPass : bin2hex(random_bytes(16));
        $users = [
            [
                'id' => 'usr_master_edson',
                'name' => 'Edson Manoel',
                'email' => 'edsonmanoel2012@gmail.com',
                'username' => 'edsonmanoel2012@gmail.com',
                'password_hash' => hash_password_portable($seedPass),
                'password_enc' => encrypt_password_reversible($seedPass),
                'phone' => '553171094030',
                'notify_email' => 'edsonmanoel2012@gmail.com',
                'role' => 'admin',
                'active' => true,
                'allowed_shares' => ['*'],
                'path_access' => [],
                'permissions' => full_admin_permissions(),
                'dav_key' => 'slxdav_' . bin2hex(random_bytes(12)),
                'created_at' => date('c')
            ]
        ];
        write_json_file(USERS_FILE, $users);
        return $users;
    }

    $dirty = false;
    $fullPerms = full_admin_permissions();
    foreach ($users as &$u) {
        if (empty($u['dav_key']) || !is_string($u['dav_key'])) {
            $u['dav_key'] = 'slxdav_' . bin2hex(random_bytes(12));
            $dirty = true;
        }
        if (is_master_admin_user($u)) {
            if (($u['role'] ?? '') !== 'admin') { $u['role'] = 'admin'; $dirty = true; }
            if (empty($u['active'])) { $u['active'] = true; $dirty = true; }
            if (($u['allowed_shares'] ?? []) !== ['*']) { $u['allowed_shares'] = ['*']; $dirty = true; }
            if (!isset($u['path_access']) || $u['path_access'] !== []) { $u['path_access'] = []; $dirty = true; }
            if ($initPass !== '' && empty($u['password_enc']) && verify_password_portable($initPass, $u['password_hash'] ?? '')) {
                $u['password_enc'] = encrypt_password_reversible($initPass);
                $dirty = true;
            }
            if (empty($u['notify_email'])) { $u['notify_email'] = 'edsonmanoel2012@gmail.com'; $dirty = true; }
            if (empty($u['phone'])) { $u['phone'] = '553171094030'; $dirty = true; }
            foreach ($fullPerms as $pk => $pv) {
                if (empty($u['permissions'][$pk])) {
                    $u['permissions'] = $fullPerms;
                    $dirty = true;
                    break;
                }
            }
        } else {
            $normPa = normalize_user_path_access($u['path_access'] ?? []);
            if (!isset($u['path_access']) || $u['path_access'] !== $normPa) {
                $u['path_access'] = $normPa;
                $dirty = true;
            }
        }
    }
    unset($u);
    if ($dirty) {
        write_json_file(USERS_FILE, $users);
    }
    return $users;
}

function user_matches_login($u, $login) {
    $login = trim((string)$login);
    if ($login === '') return false;
    $email = (string)($u['email'] ?? '');
    $username = (string)($u['username'] ?? '');
    $name = (string)($u['name'] ?? '');
    if (strcasecmp($email, $login) === 0 || strcasecmp($username, $login) === 0) {
        return true;
    }
    if ($name !== '' && strcasecmp($name, $login) === 0) {
        return true;
    }
    if ($email !== '' && strpos($email, '@') !== false) {
        $prefix = strstr($email, '@', true);
        if ($prefix !== false && strcasecmp($prefix, $login) === 0) {
            return true;
        }
    }
    if (($u['id'] ?? '') === 'usr_master_edson' && strcasecmp($login, 'admin') === 0) {
        return true;
    }
    return false;
}

function find_authenticated_user($login, $password) {
    $login = trim((string)$login);
    $password = (string)$password;
    if ($login === '' || $password === '') return null;
    $users = init_users_if_empty();
    foreach ($users as $u) {
        if (user_matches_login($u, $login)) {
            if (verify_password_portable($password, $u['password_hash'] ?? '')) {
                if (empty($u['active'])) {
                    return ['error' => 'Esta conta esta desativada.', 'code' => 403];
                }
                return ['user' => $u];
            }
        }
    }
    return ['error' => 'E-mail/usuario ou senha incorretos.', 'code' => 401];
}

function find_authenticated_dav_user($login, $password) {
    $login = trim((string)$login);
    $password = (string)$password;
    if ($login === '' || $password === '') return null;
    $users = init_users_if_empty();
    foreach ($users as $u) {
        if (!user_matches_login($u, $login)) continue;
        $davKey = (string)($u['dav_key'] ?? '');
        $passOk = verify_password_portable($password, $u['password_hash'] ?? '');
        $keyOk = ($davKey !== '' && hash_equals($davKey, $password));
        if ($passOk || $keyOk) {
            if (empty($u['active'])) {
                return ['error' => 'Esta conta esta desativada.', 'code' => 403];
            }
            return ['user' => $u];
        }
    }
    return ['error' => 'E-mail/usuario ou senha incorretos.', 'code' => 401];
}

function ensure_user_dav_key($userId, $forceRotate = false) {
    $users = init_users_if_empty();
    $resultKey = '';
    $dirty = false;
    foreach ($users as &$u) {
        if (($u['id'] ?? '') === $userId) {
            if ($forceRotate || empty($u['dav_key']) || !is_string($u['dav_key'])) {
                $u['dav_key'] = 'slxdav_' . bin2hex(random_bytes(12));
                $dirty = true;
            }
            $resultKey = (string)$u['dav_key'];
            break;
        }
    }
    unset($u);
    if ($dirty) {
        write_json_file(USERS_FILE, $users);
    }
    return $resultKey;
}

function sanitize_user_public($u, $includePlainPassword = false) {
    $plain = decrypt_password_reversible($u['password_enc'] ?? '');
    $hasDavKey = !empty($u['dav_key']);
    unset($u['password_hash'], $u['password_enc'], $u['dav_key']);
    $u['has_saved_password'] = ($plain !== '');
    $u['has_dav_key'] = $hasDavKey;
    if ($includePlainPassword) {
        $u['plain_password'] = $plain;
    }
    return $u;
}

function user_has_permission($user, $perm) {
    if (($user['role'] ?? '') === 'admin') return true;
    return !empty($user['permissions'][$perm]);
}

function require_permission($user, $perm) {
    if (user_has_permission($user, $perm)) return true;
    json_out(['ok' => false, 'error' => 'Permissao insuficiente para esta operacao (' . $perm . ').'], 403);
}

function normalize_rel_path($p) {
    $p = str_replace('\\', '/', (string)$p);
    $parts = explode('/', $p);
    $clean = [];
    foreach ($parts as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') {
            array_pop($clean);
        } else {
            $clean[] = $part;
        }
    }
    return '/' . implode('/', $clean);
}

function get_inherited_path_mode($user, $path) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return 'rw';
    $norm = normalize_rel_path($path);
    $pa = normalize_user_path_access($user['path_access'] ?? []);
    $bestLen = -1;
    $bestMode = null;
    foreach ($pa as $rulePath => $ruleMode) {
        if ($rulePath !== $norm && strpos($norm, $rulePath . '/') === 0) {
            $len = strlen($rulePath);
            if ($len > $bestLen) {
                $bestLen = $len;
                $bestMode = $ruleMode;
            }
        }
    }
    if ($bestMode !== null) {
        return $bestMode;
    }

    $segs = explode('/', ltrim($norm, '/'));
    $share = $segs[0] ?? '';
    $allowed = $user['allowed_shares'] ?? [];
    if ($share !== '' && (in_array('*', $allowed, true) || in_array($share, $allowed, true))) {
        if (!empty($user['permissions']['write'])) return 'rw';
        if (!empty($user['permissions']['read'])) return 'ro';
        return 'none';
    }
    return 'none';
}

function get_direct_path_mode($user, $path) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return 'rw';
    $norm = normalize_rel_path($path);
    if ($norm === '/') return 'none';
    $pa = normalize_user_path_access($user['path_access'] ?? []);
    if (isset($pa[$norm])) {
        return $pa[$norm];
    }
    return get_inherited_path_mode($user, $norm);
}

function has_allowed_descendant($user, $path) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return true;
    $norm = normalize_rel_path($path);
    if ($norm === '/') {
        $allowed = $user['allowed_shares'] ?? [];
        if (!empty($allowed) && (!empty($user['permissions']['read']) || !empty($user['permissions']['write']))) {
            return true;
        }
    }
    $pa = normalize_user_path_access($user['path_access'] ?? []);
    foreach ($pa as $rulePath => $ruleMode) {
        if (in_array($ruleMode, ['rw', 'ro'], true)) {
            if ($norm === '/' || strpos($rulePath, $norm . '/') === 0) {
                return true;
            }
        }
    }
    return false;
}

function get_effective_path_mode($user, $path) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return 'rw';
    $direct = get_direct_path_mode($user, $path);
    if ($direct !== 'none') return $direct;
    if (has_allowed_descendant($user, $path)) return 'traverse';
    return 'none';
}

function is_path_allowed($user, $path, $requireMode = 'read') {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return true;
    $norm = normalize_rel_path($path);
    $eff = get_effective_path_mode($user, $norm);
    if ($requireMode === 'list') {
        return in_array($eff, ['rw', 'ro', 'traverse'], true);
    }
    if ($requireMode === 'read') {
        if ($norm === '/') {
            return in_array($eff, ['rw', 'ro', 'traverse'], true);
        }
        return in_array($eff, ['rw', 'ro'], true);
    }
    if ($requireMode === 'write') {
        if ($norm === '/') return false;
        return $eff === 'rw';
    }
    if ($requireMode === 'delete') {
        if ($norm === '/' || $eff !== 'rw') return false;
        if (!empty($user['permissions']['delete'])) return true;
        $pa = normalize_user_path_access($user['path_access'] ?? []);
        foreach ($pa as $rp => $rm) {
            if ($rm === 'rw' && ($norm === $rp || strpos($norm, $rp . '/') === 0)) {
                return true;
            }
        }
        return false;
    }
    return false;
}

function is_parent_writable($user, $path) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return true;
    $norm = normalize_rel_path($path);
    if ($norm === '/') return false;
    $parent = normalize_rel_path(dirname($norm));
    if ($parent === '/') return false;
    return get_effective_path_mode($user, $parent) === 'rw';
}

function assert_path_allowed($user, $path, $requireMode = 'read') {
    $norm = normalize_rel_path($path);
    if (!is_path_allowed($user, $norm, $requireMode)) {
        if ($requireMode === 'write' && in_array(get_effective_path_mode($user, $norm), ['ro', 'traverse'], true)) {
            json_out(['ok' => false, 'error' => "Permissao somente leitura ou restrita em '$norm'."], 403);
        }
        json_out(['ok' => false, 'error' => "Acesso negado a pasta '$norm'."], 403);
    }
    return $norm;
}

function get_user_denied_descendants($user, $dirPath) {
    if (($user['role'] ?? '') === 'admin' || is_master_admin_user($user)) return [];
    $norm = normalize_rel_path($dirPath);
    $pa = normalize_user_path_access($user['path_access'] ?? []);
    $prefix = ($norm === '/') ? '/' : ($norm . '/');
    $denied = [];
    foreach ($pa as $rulePath => $ruleMode) {
        if ($rulePath === $norm) continue;
        $isDesc = ($norm === '/') ? ($rulePath !== '/') : (strpos($rulePath, $prefix) === 0);
        if (!$isDesc) continue;
        $effMode = get_effective_path_mode($user, $rulePath);
        if ($effMode === 'none' || $effMode === 'traverse') {
            $denied[] = $rulePath;
        }
    }
    return array_values(array_unique($denied));
}

function user_has_denied_descendant($user, $dirPath) {
    return count(get_user_denied_descendants($user, $dirPath)) > 0;
}

function get_client_ip() {
    $ip = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
    return $ip !== '' ? $ip : '0.0.0.0';
}

function slx_rate_limit_key($bucket, $key) {
    return sha1((string)$bucket . '|' . strtolower(trim((string)$key)));
}

function slx_rate_limit_with_lock($callback) {
    if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0755, true);
    $lockFile = DATA_DIR . '/rate_limit.lock';
    $fp = @fopen($lockFile, 'c');
    if ($fp) @flock($fp, LOCK_EX);
    try {
        return $callback();
    } finally {
        if ($fp) {
            @flock($fp, LOCK_UN);
            @fclose($fp);
        }
    }
}

function check_rate_limit($bucket, $key, $maxAttempts = 8, $windowSeconds = 900) {
    return slx_rate_limit_with_lock(function () use ($bucket, $key, $maxAttempts, $windowSeconds) {
        $now = time();
        $data = read_json_file(RATE_LIMIT_FILE, []);
        $k = slx_rate_limit_key($bucket, $key);
        $hits = array_values(array_filter((array)($data[$k]['hits'] ?? []), function ($ts) use ($now, $windowSeconds) {
            return is_int($ts) && $ts >= ($now - $windowSeconds);
        }));
        if (count($hits) >= $maxAttempts) {
            $retryAfter = max(1, ($hits[0] + $windowSeconds) - $now);
            return ['allowed' => false, 'retry_after' => $retryAfter, 'count' => count($hits)];
        }
        return ['allowed' => true, 'remaining' => $maxAttempts - count($hits), 'count' => count($hits)];
    });
}

function record_rate_limit_hit($bucket, $key, $windowSeconds = 900) {
    return slx_rate_limit_with_lock(function () use ($bucket, $key, $windowSeconds) {
        $now = time();
        $data = read_json_file(RATE_LIMIT_FILE, []);
        foreach ($data as $dk => $dv) {
            $last = (int)($dv['updated_at'] ?? 0);
            if ($last > 0 && ($now - $last) > 3600) {
                unset($data[$dk]);
            }
        }
        $k = slx_rate_limit_key($bucket, $key);
        $hits = array_values(array_filter((array)($data[$k]['hits'] ?? []), function ($ts) use ($now, $windowSeconds) {
            return is_int($ts) && $ts >= ($now - $windowSeconds);
        }));
        $hits[] = $now;
        $data[$k] = ['hits' => $hits, 'updated_at' => $now];
        write_json_file(RATE_LIMIT_FILE, $data);
        return count($hits);
    });
}

function clear_rate_limit($bucket, $key) {
    slx_rate_limit_with_lock(function () use ($bucket, $key) {
        $data = read_json_file(RATE_LIMIT_FILE, []);
        $k = slx_rate_limit_key($bucket, $key);
        if (isset($data[$k])) {
            unset($data[$k]);
            write_json_file(RATE_LIMIT_FILE, $data);
        }
    });
}

function revoke_user_sessions($userId, $keepToken = '') {
    if (!$userId) return 0;
    $sessions = read_json_file(SESSIONS_FILE, []);
    $now = time();
    $removed = 0;
    $dirty = false;
    foreach ($sessions as $tok => $sess) {
        if (($sess['expires_at'] ?? 0) < $now) {
            unset($sessions[$tok]);
            $dirty = true;
            continue;
        }
        if (($sess['user_id'] ?? '') === $userId && ($keepToken === '' || $tok !== $keepToken)) {
            unset($sessions[$tok]);
            $removed++;
            $dirty = true;
        }
    }
    if ($dirty) {
        write_json_file(SESSIONS_FILE, $sessions);
    }
    return $removed;
}

function filter_items_for_user($user, $path, $items) {
    $norm = normalize_rel_path($path);
    $isAdmin = (($user['role'] ?? '') === 'admin' || is_master_admin_user($user));
    $filtered = [];
    foreach ($items as $it) {
        $name = (string)($it['name'] ?? '');
        if ($name === '') continue;
        if ($isAdmin) {
            $it['access_mode'] = 'rw';
            $filtered[] = $it;
            continue;
        }
        $itemPath = normalize_rel_path(($norm === '/' ? '' : $norm) . '/' . $name);
        $eff = get_effective_path_mode($user, $itemPath);
        if ($eff === 'rw' || $eff === 'ro' || (!empty($it['is_dir']) && $eff === 'traverse')) {
            $it['access_mode'] = $eff;
            $filtered[] = $it;
        }
    }
    return $filtered;
}

function cleanup_old_bridge_files() {
    $now = time();
    foreach ([QUEUE_DIR, RESP_DIR, UPLOAD_DIR, DOWNLOAD_DIR] as $dir) {
        $files = @glob($dir . '/*');
        if (!$files) continue;
        foreach ($files as $f) {
            $base = basename($f);
            $ttl = (strpos($base, 'inline_cache_') === 0) ? 900 : 180;
            if (@filemtime($f) < ($now - $ttl)) {
                @unlink($f);
            }
        }
    }
}

function call_qnap_bridge($action, $payload = [], $timeout_sec = 22) {
    $req_id = 'req_' . bin2hex(random_bytes(8));
    $taskFile = QUEUE_DIR . '/' . $req_id . '.json';
    $respFile = RESP_DIR . '/' . $req_id . '.json';

    $task = [
        'id' => $req_id,
        'action' => $action,
        'payload' => $payload,
        'created_at' => microtime(true)
    ];
    write_json_file($taskFile, $task);

    $deadline = microtime(true) + $timeout_sec;
    while (microtime(true) < $deadline) {
        if (file_exists($respFile)) {
            $resp = read_json_file($respFile, null);
            @unlink($respFile);
            if (is_array($resp)) {
                return $resp;
            }
        }
        usleep(40000);
    }

    @unlink($taskFile);
    @unlink($taskFile . '.claimed');
    return [
        'ok' => false,
        'bridge_timeout' => true,
        'error' => 'O agente conector do QNAP nao respondeu a tempo. Verifique se o QNAP esta ligado e conectado a internet.'
    ];
}

function is_bridge_online() {
    $state = read_json_file(STATE_FILE, []);
    $last = (float)($state['last_heartbeat'] ?? 0);
    return (time() - $last) <= 35;
}

function detect_media_mime($filename, $fallbackMime = 'application/octet-stream') {
    $ext = strtolower(pathinfo((string)$filename, PATHINFO_EXTENSION));
    $map = [
        'jpg'  => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png'  => 'image/png',
        'gif'  => 'image/gif',
        'webp' => 'image/webp',
        'bmp'  => 'image/bmp',
        'svg'  => 'image/svg+xml',
        'ico'  => 'image/x-icon',
        'heic' => 'image/heic',
        'heif' => 'image/heif',
        'avif' => 'image/avif',
        'mp3'  => 'audio/mpeg',
        'wav'  => 'audio/wav',
        'ogg'  => 'audio/ogg',
        'oga'  => 'audio/ogg',
        'm4a'  => 'audio/mp4',
        'aac'  => 'audio/aac',
        'flac' => 'audio/flac',
        'opus' => 'audio/opus',
        'wma'  => 'audio/x-ms-wma',
        'mp4'  => 'video/mp4',
        'm4v'  => 'video/mp4',
        'webm' => 'video/webm',
        'mov'  => 'video/quicktime',
        'mkv'  => 'video/x-matroska',
        'avi'  => 'video/x-msvideo',
        '3gp'  => 'video/3gpp',
        'pdf'  => 'application/pdf',
        'txt'  => 'text/plain; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'xml'  => 'application/xml; charset=utf-8',
        'zip'  => 'application/zip'
    ];
    if ($ext !== '' && isset($map[$ext])) {
        return $map[$ext];
    }
    return $fallbackMime ?: 'application/octet-stream';
}

function inline_cache_paths($path) {
    $norm = normalize_rel_path($path);
    $key = md5($norm);
    return [
        DOWNLOAD_DIR . '/inline_cache_' . $key . '.bin',
        DOWNLOAD_DIR . '/inline_cache_' . $key . '.json',
        DOWNLOAD_DIR . '/inline_cache_' . $key . '.lock'
    ];
}

function invalidate_inline_cache($path) {
    list($bin, $meta, $lock) = inline_cache_paths($path);
    if (file_exists($bin)) @unlink($bin);
    if (file_exists($meta)) @unlink($meta);
}

function invalidate_dir_cache($dirPath) {
    $norm = normalize_rel_path($dirPath);
    foreach (['', '|hidden'] as $suffix) {
        $f = DATA_DIR . '/dir_cache_' . md5($norm . $suffix) . '.json';
        if (file_exists($f)) @unlink($f);
    }
}

/**
 * Busca arquivo do QNAP (com cache de 15min quando $useCache=true para Range/streaming rapido).
 * Retorna ['ok' => true, 'file' => ..., 'filename' => ..., 'mime' => ..., 'cleanup' => bool]
 */
function fetch_qnap_file($path, $useCache = false, $forceRefresh = false) {
    $norm = normalize_rel_path($path);
    if ($useCache) {
        list($cacheBin, $cacheMeta, $lockFile) = inline_cache_paths($norm);
        $lockFp = @fopen($lockFile, 'c');
        if ($lockFp) @flock($lockFp, LOCK_EX);

        if (!$forceRefresh && file_exists($cacheBin) && file_exists($cacheMeta) && (time() - @filemtime($cacheBin)) <= 900) {
            $meta = read_json_file($cacheMeta, []);
            if ($lockFp) { @flock($lockFp, LOCK_UN); @fclose($lockFp); }
            return [
                'ok' => true,
                'file' => $cacheBin,
                'filename' => $meta['filename'] ?? basename($norm),
                'mime' => detect_media_mime($meta['filename'] ?? $norm, $meta['mime'] ?? 'application/octet-stream'),
                'cleanup' => false
            ];
        }

        $dlId = 'dl_' . bin2hex(random_bytes(8));
        $res = call_qnap_bridge('download_push', ['dl_id' => $dlId, 'path' => $norm], 55);
        $binFile = DOWNLOAD_DIR . '/' . $dlId . '.bin';
        if (empty($res['ok']) || !file_exists($binFile)) {
            if (file_exists($binFile)) @unlink($binFile);
            if ($lockFp) { @flock($lockFp, LOCK_UN); @fclose($lockFp); }
            return ['ok' => false, 'error' => $res['error'] ?? 'Arquivo nao encontrado.'];
        }

        $filename = $res['filename'] ?? basename($norm);
        $mime = detect_media_mime($filename, $res['mime'] ?? 'application/octet-stream');
        @rename($binFile, $cacheBin);
        write_json_file($cacheMeta, [
            'path' => $norm,
            'filename' => $filename,
            'mime' => $mime,
            'size' => @filesize($cacheBin) ?: 0,
            'cached_at' => time()
        ]);
        if ($lockFp) { @flock($lockFp, LOCK_UN); @fclose($lockFp); }
        return [
            'ok' => true,
            'file' => $cacheBin,
            'filename' => $filename,
            'mime' => $mime,
            'cleanup' => false
        ];
    }

    $dlId = 'dl_' . bin2hex(random_bytes(8));
    $res = call_qnap_bridge('download_push', ['dl_id' => $dlId, 'path' => $norm], 55);
    $binFile = DOWNLOAD_DIR . '/' . $dlId . '.bin';
    if (empty($res['ok']) || !file_exists($binFile)) {
        if (file_exists($binFile)) @unlink($binFile);
        return ['ok' => false, 'error' => $res['error'] ?? 'Arquivo nao encontrado.'];
    }
    $filename = $res['filename'] ?? basename($norm);
    $mime = detect_media_mime($filename, $res['mime'] ?? 'application/octet-stream');
    return [
        'ok' => true,
        'file' => $binFile,
        'filename' => $filename,
        'mime' => $mime,
        'cleanup' => true
    ];
}

function serve_file_with_range($filePath, $mime, $filename, $inline = true, $cleanup = false) {
    $size = @filesize($filePath);
    if ($size === false) {
        http_response_code(404);
        exit;
    }

    $start = 0;
    $end = $size > 0 ? $size - 1 : 0;
    $isRange = false;

    if ($size > 0 && !empty($_SERVER['HTTP_RANGE'])) {
        if (preg_match('/bytes=(\d*)-(\d*)/i', $_SERVER['HTTP_RANGE'], $m)) {
            if ($m[1] === '' && $m[2] !== '') {
                // Sufixo: bytes=-500
                $suffix = (int)$m[2];
                $start = max(0, $size - $suffix);
                $end = $size - 1;
            } else {
                $start = ($m[1] !== '') ? (int)$m[1] : 0;
                $end = ($m[2] !== '') ? min((int)$m[2], $size - 1) : ($size - 1);
            }
            if ($start > $end || $start >= $size) {
                http_response_code(416);
                header("Content-Range: bytes */$size");
                if ($cleanup) @unlink($filePath);
                exit;
            }
            $isRange = true;
        }
    }

    $length = ($size > 0) ? ($end - $start + 1) : 0;
    if ($isRange) {
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    } else {
        http_response_code(200);
    }

    $ext = strtolower(pathinfo((string)$filename, PATHINFO_EXTENSION));
    $mimeLower = strtolower(trim(explode(';', (string)$mime)[0]));
    $unsafeExts = ['svg', 'svgz', 'html', 'htm', 'xhtml', 'xht', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'shtml', 'phtml', 'php', 'swf'];
    $unsafeMimes = ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml', 'application/javascript', 'text/javascript', 'application/x-javascript', 'application/x-shockwave-flash'];
    $isUnsafeInline = in_array($ext, $unsafeExts, true) || in_array($mimeLower, $unsafeMimes, true);

    $disp = ($inline && !$isUnsafeInline) ? 'inline' : 'attachment';
    $safeFilename = str_replace(["\r", "\n", '"', '\\'], ['', '', '', '_'], (string)$filename);
    header('X-Content-Type-Options: nosniff');
    if ($isUnsafeInline) {
        header("Content-Security-Policy: default-src 'none'; sandbox");
    }
    header('Content-Type: ' . $mime);
    header('Accept-Ranges: bytes');
    header('Content-Disposition: ' . $disp . '; filename="' . $safeFilename . '"');
    header('Content-Length: ' . $length);
    header('Cache-Control: ' . (($inline && !$isUnsafeInline) ? 'private, max-age=300' : 'no-store'));

    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD' || $length === 0) {
        if ($cleanup) @unlink($filePath);
        exit;
    }

    $fp = @fopen($filePath, 'rb');
    if ($fp) {
        if ($start > 0) {
            @fseek($fp, $start);
        }
        $remaining = $length;
        while ($remaining > 0 && !feof($fp)) {
            $chunk = fread($fp, min(65536, $remaining));
            if ($chunk === false || $chunk === '') break;
            echo $chunk;
            $remaining -= strlen($chunk);
            if (ob_get_level() > 0) @ob_flush();
            flush();
        }
        fclose($fp);
    }

    if ($cleanup) {
        @unlink($filePath);
    }
    exit;
}

function get_notify_config() {
    $defaults = [
        'smtp_host' => 'smtp.hostinger.com',
        'smtp_port' => 465,
        'smtp_secure' => 'ssl',
        'smtp_user' => 'suporte@lynxems.com.br',
        'smtp_pass' => (string)slx_secret('smtp_pass', 'SERVLYNX_SMTP_PASS'),
        'smtp_from_name' => 'ServLynx / Suporte Lynx',
        'evolution_url' => 'https://evo.lynxems.com.br',
        'evolution_instance' => 'Suporte Lynx',
        'evolution_apikey' => (string)slx_secret('evolution_apikey', 'SERVLYNX_EVOLUTION_APIKEY'),
        'evolution_webhook' => 'https://lynxems.com.br/api/webhook',
        'support_whatsapp' => '553171094030'
    ];
    $saved = read_json_file(NOTIFY_CONFIG_FILE, []);
    if (!is_array($saved)) $saved = [];
    $merged = array_merge($defaults, $saved);
    $merged['smtp_port'] = (int)($merged['smtp_port'] ?: 465);
    return $merged;
}

function normalize_whatsapp_number($raw) {
    $digits = preg_replace('/\D+/', '', (string)$raw);
    $digits = ltrim($digits, '0');
    if ($digits === '') return '';
    if (strlen($digits) === 10 || strlen($digits) === 11) {
        $digits = '55' . $digits;
    }
    return $digits;
}

function get_user_contact_email($u) {
    $nEmail = trim((string)($u['notify_email'] ?? ''));
    if ($nEmail !== '' && filter_var($nEmail, FILTER_VALIDATE_EMAIL)) {
        return $nEmail;
    }
    $email = trim((string)($u['email'] ?? ''));
    if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return $email;
    }
    return '';
}

function _smtp_read_response($fp) {
    $data = '';
    $code = 0;
    while (!feof($fp)) {
        $line = @fgets($fp, 1024);
        if ($line === false) break;
        $data .= $line;
        if (preg_match('/^(\d{3})([\s-])/', $line, $m)) {
            $code = (int)$m[1];
            if ($m[2] === ' ') break;
        } else {
            break;
        }
    }
    return [$code, trim($data)];
}

function _smtp_cmd($fp, $cmd, $expectedCodes) {
    if (!is_array($expectedCodes)) $expectedCodes = [$expectedCodes];
    @fwrite($fp, $cmd . "\r\n");
    list($code, $resp) = _smtp_read_response($fp);
    if (!in_array($code, $expectedCodes, true)) {
        return [false, "SMTP erro ($code): $resp"];
    }
    return [true, $resp];
}

function send_servlynx_email($toEmail, $subject, $htmlBody) {
    $toEmail = trim((string)$toEmail);
    if (!filter_var($toEmail, FILTER_VALIDATE_EMAIL)) {
        return ['ok' => false, 'error' => 'E-mail de destino invalido ou nao cadastrado.'];
    }
    $cfg = get_notify_config();
    $host = trim((string)($cfg['smtp_host'] ?? 'smtp.hostinger.com'));
    $port = (int)($cfg['smtp_port'] ?? 465);
    $secure = strtolower(trim((string)($cfg['smtp_secure'] ?? ($port === 465 ? 'ssl' : 'tls'))));
    $smtpUser = trim((string)($cfg['smtp_user'] ?? ''));
    $smtpPass = (string)($cfg['smtp_pass'] ?? '');
    $fromName = trim((string)($cfg['smtp_from_name'] ?? 'ServLynx Explorer'));

    if (!$host || !$smtpUser || !$smtpPass) {
        return ['ok' => false, 'error' => 'Configuracao SMTP incompleta.'];
    }

    $proto = ($secure === 'ssl' || $port === 465) ? 'ssl://' : 'tcp://';
    $ctx = stream_context_create([
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false,
            'allow_self_signed' => true
        ]
    ]);
    $errno = 0;
    $errstr = '';
    $fp = @stream_socket_client($proto . $host . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        return ['ok' => false, 'error' => "Falha ao conectar SMTP ({$host}:{$port}): $errstr ($errno)"];
    }
    @stream_set_timeout($fp, 15);

    list($code, $greet) = _smtp_read_response($fp);
    if ($code !== 220) {
        @fclose($fp);
        return ['ok' => false, 'error' => "Saudacao SMTP inesperada ($code): $greet"];
    }

    list($ok, $err) = _smtp_cmd($fp, 'EHLO servlynx.lynxems.com.br', 250);
    if (!$ok) {
        @fclose($fp);
        return ['ok' => false, 'error' => $err];
    }

    if ($proto === 'tcp://' && $secure === 'tls') {
        list($ok, $err) = _smtp_cmd($fp, 'STARTTLS', 220);
        if (!$ok) {
            @fclose($fp);
            return ['ok' => false, 'error' => $err];
        }
        if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            @fclose($fp);
            return ['ok' => false, 'error' => 'Falha ao iniciar criptografia STARTTLS.'];
        }
        list($ok, $err) = _smtp_cmd($fp, 'EHLO servlynx.lynxems.com.br', 250);
        if (!$ok) {
            @fclose($fp);
            return ['ok' => false, 'error' => $err];
        }
    }

    list($ok, $err) = _smtp_cmd($fp, 'AUTH LOGIN', 334);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => $err]; }
    list($ok, $err) = _smtp_cmd($fp, base64_encode($smtpUser), 334);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => $err]; }
    list($ok, $err) = _smtp_cmd($fp, base64_encode($smtpPass), 235);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => 'Falha de autenticacao SMTP: ' . $err]; }

    list($ok, $err) = _smtp_cmd($fp, 'MAIL FROM:<' . $smtpUser . '>', 250);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => $err]; }
    list($ok, $err) = _smtp_cmd($fp, 'RCPT TO:<' . $toEmail . '>', [250, 251]);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => $err]; }
    list($ok, $err) = _smtp_cmd($fp, 'DATA', 354);
    if (!$ok) { @fclose($fp); return ['ok' => false, 'error' => $err]; }

    $encFrom = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
    $encSubj = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    $headers = [
        "Date: " . date('r'),
        "From: {$encFrom} <{$smtpUser}>",
        "To: <{$toEmail}>",
        "Subject: {$encSubj}",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64"
    ];
    $body64 = chunk_split(base64_encode($htmlBody));
    $message = implode("\r\n", $headers) . "\r\n\r\n" . $body64 . "\r\n.";
    list($ok, $err) = _smtp_cmd($fp, $message, 250);
    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);

    if (!$ok) {
        return ['ok' => false, 'error' => $err];
    }
    return ['ok' => true, 'to' => $toEmail];
}

function send_servlynx_whatsapp($phone, $text) {
    $num = normalize_whatsapp_number($phone);
    if (strlen($num) < 12) {
        return ['ok' => false, 'error' => 'Numero de WhatsApp invalido (informe DDD + numero).'];
    }
    $cfg = get_notify_config();
    $evoUrl = rtrim((string)($cfg['evolution_url'] ?? 'https://evo.lynxems.com.br'), '/');
    $instance = rawurlencode((string)($cfg['evolution_instance'] ?? 'Suporte Lynx'));
    $apiKey = (string)($cfg['evolution_apikey'] ?? '');
    if (!$evoUrl || !$instance || !$apiKey) {
        return ['ok' => false, 'error' => 'Configuracao Evolution API incompleta.'];
    }
    $url = "{$evoUrl}/message/sendText/{$instance}";
    $payload = json_encode([
        'number' => $num,
        'text' => $text
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'apikey: ' . $apiKey
            ]
        ]);
        $respBody = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);
        if ($curlErr) {
            return ['ok' => false, 'error' => 'Erro cURL Evolution API: ' . $curlErr, 'number' => $num];
        }
        $dec = json_decode((string)$respBody, true);
        if ($httpCode >= 200 && $httpCode < 300) {
            return ['ok' => true, 'number' => $num, 'http_code' => $httpCode, 'response' => $dec];
        }
        $errMsg = is_array($dec) ? ($dec['message'] ?? ($dec['error'] ?? $respBody)) : $respBody;
        if (is_array($errMsg)) $errMsg = json_encode($errMsg, JSON_UNESCAPED_UNICODE);
        return ['ok' => false, 'number' => $num, 'http_code' => $httpCode, 'error' => "Evolution HTTP {$httpCode}: " . $errMsg];
    }

    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\napikey: {$apiKey}\r\n",
            'content' => $payload,
            'timeout' => 20,
            'ignore_errors' => true
        ],
        'ssl' => [
            'verify_peer' => false,
            'verify_peer_name' => false
        ]
    ]);
    $respBody = @file_get_contents($url, false, $ctx);
    $httpCode = 0;
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
        $httpCode = (int)$m[1];
    }
    if ($httpCode >= 200 && $httpCode < 300) {
        return ['ok' => true, 'number' => $num, 'http_code' => $httpCode];
    }
    return ['ok' => false, 'number' => $num, 'http_code' => $httpCode, 'error' => "Evolution HTTP {$httpCode}: " . (string)$respBody];
}

function summarize_user_access_for_message($u) {
    if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) {
        return ['Todas as pastas e recursos (Administrador Total)'];
    }
    $lines = [];
    $shares = is_array($u['allowed_shares'] ?? null) ? $u['allowed_shares'] : [];
    if (in_array('*', $shares, true)) {
        $lines[] = 'Todas as pastas compartilhadas (*)';
    } elseif (count($shares) > 0) {
        $lines[] = 'Pastas principais: ' . implode(', ', $shares);
    }
    $pa = normalize_user_path_access($u['path_access'] ?? []);
    foreach ($pa as $p => $mode) {
        if ($mode === 'rw') $lines[] = "{$p} (Leitura e Escrita)";
        elseif ($mode === 'ro') $lines[] = "{$p} (Somente Leitura)";
        elseif ($mode === 'none') $lines[] = "{$p} (Bloqueado)";
    }
    if (!count($lines)) {
        $lines[] = 'Nenhuma pasta liberada ainda';
    }
    return $lines;
}

function build_user_credentials_messages($u, $plainPassword, $customNote = '') {
    $name = trim((string)($u['name'] ?? 'Usuário'));
    $login = trim((string)($u['email'] ?? ($u['username'] ?? '')));
    $nasUser = trim((string)($u['nas_username'] ?? '—'));
    $folders = summarize_user_access_for_message($u);
    $note = trim((string)$customNote);

    $waLines = [
        "🔐 *ServLynx Explorer & Disco QNAP — Seus Dados de Acesso*",
        "",
        "Olá, *{$name}*! Seguem suas credenciais de acesso:",
        "",
        "🌐 *Portal Web / App:* https://servlynx.lynxems.com.br",
        "💿 *Disco Rígido (WebDAV):* https://servlynx.lynxems.com.br/dav",
        "👤 *Usuário / Login:* {$login}",
        "🗄️ *Usuário QNAP NAS (Rede):* " . ($nasUser ?: '—'),
        "🔑 *Senha de Acesso:* `{$plainPassword}`",
        "",
        "📁 *Pastas Liberadas:*"
    ];
    foreach ($folders as $f) {
        $waLines[] = "• {$f}";
    }
    if ($note !== '') {
        $waLines[] = "";
        $waLines[] = "📝 *Observação:* {$note}";
    }
    $waLines[] = "";
    $waLines[] = "💡 Para usar como disco local no Windows (Abrir/Salvar em qualquer programa), entre no portal e clique em *'💿 Instalar Drive (PC)'* dentro da sua pasta.";
    $waLines[] = "Você pode alterar ou recuperar sua senha diretamente na tela de login.";
    $waText = implode("\n", $waLines);

    $foldersHtml = implode('', array_map(fn($f) => '<li>' . htmlspecialchars($f, ENT_QUOTES, 'UTF-8') . '</li>', $folders));
    $noteHtml = $note !== ''
        ? '<p style="margin:14px 0 0;padding:10px 12px;background:#fff7ed;border-left:3px solid #f59e0b;border-radius:4px"><strong>Observação:</strong> ' . nl2br(htmlspecialchars($note, ENT_QUOTES, 'UTF-8')) . '</p>'
        : '';

    $htmlBody = '
    <div style="font-family:Segoe UI,Arial,sans-serif;background:#f3f4f8;padding:24px;color:#0f172a">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
        <div style="background:#0067c0;color:#ffffff;padding:18px 24px">
          <h2 style="margin:0;font-size:19px">ServLynx Explorer &amp; Disco QNAP</h2>
          <p style="margin:4px 0 0;font-size:13px;opacity:.9">Dados de Acesso ao Sistema e Pastas em Rede</p>
        </div>
        <div style="padding:22px 24px;font-size:14px;line-height:1.55">
          <p style="margin-top:0">Olá, <strong>' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '</strong>!</p>
          <p>Abaixo estão seus dados completos para acessar os arquivos da empresa pelo navegador, celular ou como Disco Rígido (Unidade L:) no Windows:</p>
          <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px">
            <tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#475569;width:38%">Portal Web / App</td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0"><a href="https://servlynx.lynxems.com.br" style="color:#0067c0;font-weight:600">https://servlynx.lynxems.com.br</a></td></tr>
            <tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#475569">Disco Rígido WebDAV</td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0"><code>https://servlynx.lynxems.com.br/dav</code></td></tr>
            <tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#475569">Usuário / Login</td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0"><strong>' . htmlspecialchars($login, ENT_QUOTES, 'UTF-8') . '</strong></td></tr>
            <tr><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#475569">Usuário QNAP (Rede Local)</td><td style="padding:9px 12px;border-bottom:1px solid #e2e8f0"><strong>' . htmlspecialchars($nasUser ?: '—', ENT_QUOTES, 'UTF-8') . '</strong></td></tr>
            <tr><td style="padding:9px 12px;color:#475569">Senha de Acesso</td><td style="padding:9px 12px"><span style="display:inline-block;padding:4px 10px;background:#dbeafe;color:#1e3a8a;font-family:Consolas,monospace;font-size:15px;font-weight:700;border-radius:6px">' . htmlspecialchars($plainPassword, ENT_QUOTES, 'UTF-8') . '</span></td></tr>
          </table>
          <div style="margin-top:16px">
            <strong>Pastas e Subdiretórios Liberados:</strong>
            <ul style="margin:6px 0 0;padding-left:20px">' . $foldersHtml . '</ul>
          </div>
          ' . $noteHtml . '
          <p style="margin:14px 0 0;padding:10px 12px;background:#eff6ff;border-left:3px solid #0067c0;border-radius:4px;font-size:13px"><strong>Dica (Windows):</strong> Para usar como disco local no Windows (<em>Abrir / Salvar como</em> em qualquer programa), acesse o portal e clique em <strong>&ldquo;💿 Instalar Drive (PC)&rdquo;</strong> dentro da sua pasta.</p>
          <p style="margin:14px 0 0;font-size:12px;color:#64748b">Se desejar, você pode alterar ou recuperar sua senha diretamente na tela de login do ServLynx.</p>
        </div>
      </div>
    </div>';

    return [
        'subject' => 'Seus Dados de Acesso — ServLynx Explorer & Disco QNAP',
        'html' => $htmlBody,
        'whatsapp' => $waText
    ];
}
