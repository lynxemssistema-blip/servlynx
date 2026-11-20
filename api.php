<?php
/**
 * ServLynx Explorer & QNAP Manager - Backend Gateway (Hostinger PHP 8.3)
 * Hospedado em: https://servlynx.lynxems.com.br
 * Comunica-se com o QNAP NAS (TS-231P) atraves da ponte segura em tempo real.
 */

require_once __DIR__ . '/bridge_lib.php';

// ==================== AUTENTICACAO DA API WEB ====================
function get_request_token() {
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (preg_match('/Bearer\s+(.+)/i', $hdr, $m)) {
        return trim($m[1]);
    }
    if (!empty($_SERVER['HTTP_X_AUTH_TOKEN'])) {
        return trim($_SERVER['HTTP_X_AUTH_TOKEN']);
    }
    if (!empty($_GET['token'])) {
        return trim($_GET['token']);
    }
    if (!empty($_COOKIE['servlynx_token'])) {
        return trim($_COOKIE['servlynx_token']);
    }
    return '';
}

function require_auth() {
    $token = get_request_token();
    if (!$token) {
        json_out(['ok' => false, 'error' => 'Sessao nao autenticada.'], 401);
    }
    $sessions = read_json_file(SESSIONS_FILE, []);
    if (!isset($sessions[$token])) {
        json_out(['ok' => false, 'error' => 'Sessao expirada ou invalida.'], 401);
    }
    $sess = $sessions[$token];
    if (($sess['expires_at'] ?? 0) < time()) {
        unset($sessions[$token]);
        write_json_file(SESSIONS_FILE, $sessions);
        json_out(['ok' => false, 'error' => 'Sessao expirada ou invalida.'], 401);
    }
    $users = init_users_if_empty();
    foreach ($users as $u) {
        if ($u['id'] === $sess['user_id']) {
            if (empty($u['active'])) {
                json_out(['ok' => false, 'error' => 'Usuario desativado pelo administrador.'], 403);
            }
            return ['token' => $token, 'user' => $u];
        }
    }
    json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 401);
}

// ==================== COMUNICACAO COM A PONTE QNAP ====================
function verify_bridge_secret() {
    $sec = $_SERVER['HTTP_X_BRIDGE_SECRET'] ?? ($_GET['secret'] ?? '');
    if (BRIDGE_SECRET === '' || !hash_equals(BRIDGE_SECRET, (string)$sec)) {
        json_out(['ok' => false, 'error' => 'Unauthorized bridge'], 403);
    }
}

// ==================== ROTEAMENTO ====================
$route = $_GET['route'] ?? ($_POST['route'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

init_users_if_empty();

// 1. Rotas da Ponte QNAP (Bridge Agent -> Hostinger)
if ($route === 'bridge_poll') {
    verify_bridge_secret();
    $agentId = $_GET['agent'] ?? 'qnap';
    $state = read_json_file(STATE_FILE, []);
    $state['last_heartbeat'] = time();
    $state['last_agent'] = $agentId;
    write_json_file(STATE_FILE, $state);

    if (mt_rand(1, 20) === 1) {
        cleanup_old_bridge_files();
    }

    $wait = min(14, max(1, (int)($_GET['wait'] ?? 12)));
    $deadline = microtime(true) + $wait;
    while (microtime(true) < $deadline) {
        $pending = @glob(QUEUE_DIR . '/*.json');
        if ($pending && count($pending) > 0) {
            sort($pending);
            $tasks = [];
            foreach ($pending as $file) {
                $claimed = $file . '.claimed';
                if (@rename($file, $claimed)) {
                    $task = read_json_file($claimed, null);
                    @unlink($claimed);
                    if (is_array($task)) {
                        $tasks[] = $task;
                    }
                    if (count($tasks) >= 5) break;
                }
            }
            if (count($tasks) > 0) {
                json_out(['ok' => true, 'tasks' => $tasks]);
            }
        }
        usleep(40000);
    }
    json_out(['ok' => true, 'tasks' => []]);
}

if ($route === 'bridge_reply') {
    verify_bridge_secret();
    $body = get_json_body();
    $req_id = basename((string)($body['id'] ?? ''));
    if (!$req_id) json_out(['ok' => false, 'error' => 'Missing id'], 400);
    write_json_file(RESP_DIR . '/' . $req_id . '.json', $body['result'] ?? ['ok' => false]);
    json_out(['ok' => true]);
}

if ($route === 'bridge_push_state') {
    verify_bridge_secret();
    $body = get_json_body();
    $state = read_json_file(STATE_FILE, []);
    $state['last_heartbeat'] = time();
    if (isset($body['agent'])) $state['last_agent'] = $body['agent'];
    if (isset($body['qnap_status'])) $state['qnap_status'] = $body['qnap_status'];
    if (isset($body['root_items'])) $state['root_items'] = $body['root_items'];
    if (isset($body['shares'])) $state['shares'] = $body['shares'];
    if (isset($body['qnap_users'])) $state['qnap_users'] = $body['qnap_users'];
    write_json_file(STATE_FILE, $state);
    json_out(['ok' => true]);
}

if ($route === 'bridge_get_upload') {
    verify_bridge_secret();
    $upId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($_GET['id'] ?? ''));
    $matches = @glob(UPLOAD_DIR . '/' . $upId . '_*');
    if (!$upId || !$matches || !file_exists($matches[0])) {
        http_response_code(404);
        exit('Not found');
    }
    $f = $matches[0];
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize($f));
    readfile($f);
    @unlink($f);
    exit;
}

if ($route === 'bridge_put_download') {
    verify_bridge_secret();
    $dlId = preg_replace('/[^a-zA-Z0-9_\-]/', '', (string)($_GET['id'] ?? ''));
    if (!$dlId) json_out(['ok' => false, 'error' => 'Missing id'], 400);
    $dest = DOWNLOAD_DIR . '/' . $dlId . '.bin';
    $in = fopen('php://input', 'rb');
    $out = fopen($dest, 'wb');
    if (!$in || !$out) json_out(['ok' => false, 'error' => 'Stream open failed'], 500);
    stream_copy_to_stream($in, $out);
    fclose($in);
    fclose($out);
    json_out(['ok' => true, 'size' => filesize($dest)]);
}

// 2. Autenticacao Web
if ($route === 'login' && $method === 'POST') {
    $body = get_json_body();
    $login = trim((string)($body['email'] ?? ($body['username'] ?? '')));
    $pass = (string)($body['password'] ?? '');
    if (!$login || !$pass) {
        json_out(['ok' => false, 'error' => 'Informe usuario/e-mail e senha.'], 400);
    }
    $ip = get_client_ip();
    $rlKey = $ip . '|' . strtolower($login);
    $rl = check_rate_limit('login', $rlKey, 8, 900);
    $rlIp = check_rate_limit('login_ip', $ip, 40, 900);
    if (!$rl['allowed'] || !$rlIp['allowed']) {
        $retry = max((int)($rl['retry_after'] ?? 0), (int)($rlIp['retry_after'] ?? 0));
        header('Retry-After: ' . max(1, $retry));
        json_out(['ok' => false, 'error' => 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.'], 429);
    }
    $authRes = find_authenticated_user($login, $pass);
    if (!$authRes || empty($authRes['user'])) {
        if (($authRes['code'] ?? 401) === 401) {
            record_rate_limit_hit('login', $rlKey, 900);
            record_rate_limit_hit('login_ip', $ip, 900);
        }
        json_out(['ok' => false, 'error' => $authRes['error'] ?? 'E-mail/usuario ou senha incorretos.'], $authRes['code'] ?? 401);
    }
    clear_rate_limit('login', $rlKey);
    $found = $authRes['user'];
    $needsRehash = is_legacy_password_hash($found['password_hash'] ?? '');
    $needsEnc = (decrypt_password_reversible($found['password_enc'] ?? '') !== $pass);
    if ($needsRehash || $needsEnc) {
        $allUsers = init_users_if_empty();
        foreach ($allUsers as &$au) {
            if ($au['id'] === $found['id']) {
                if ($needsRehash) {
                    $au['password_hash'] = hash_password_portable($pass);
                }
                $au['password_enc'] = encrypt_password_reversible($pass);
                $found = $au;
                break;
            }
        }
        unset($au);
        write_json_file(USERS_FILE, $allUsers);
    }
    $token = 'slx_' . bin2hex(random_bytes(24));
    $sessions = read_json_file(SESSIONS_FILE, []);
    // Limpa sessoes antigas (>7 dias)
    $now = time();
    foreach ($sessions as $k => $s) {
        if (($s['expires_at'] ?? 0) < $now) unset($sessions[$k]);
    }
    $sessions[$token] = [
        'user_id' => $found['id'],
        'created_at' => $now,
        'expires_at' => $now + (86400 * 7)
    ];
    write_json_file(SESSIONS_FILE, $sessions);
    @setcookie('servlynx_token', $token, [
        'expires' => $now + (86400 * 7),
        'path' => '/',
        'secure' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off'),
        'httponly' => true,
        'samesite' => 'Lax'
    ]);
    json_out([
        'ok' => true,
        'token' => $token,
        'user' => sanitize_user_public($found),
        'bridge_online' => is_bridge_online()
    ]);
}

if ($route === 'logout') {
    $token = get_request_token();
    if ($token) {
        $sessions = read_json_file(SESSIONS_FILE, []);
        unset($sessions[$token]);
        write_json_file(SESSIONS_FILE, $sessions);
    }
    @setcookie('servlynx_token', '', time() - 3600, '/');
    json_out(['ok' => true]);
}

if ($route === 'health') {
    $state = read_json_file(STATE_FILE, []);
    json_out([
        'ok' => true,
        'service' => 'ServLynx Explorer Gateway',
        'bridge_online' => is_bridge_online(),
        'last_heartbeat' => $state['last_heartbeat'] ?? null,
        'last_agent' => $state['last_agent'] ?? null
    ]);
}

function find_user_for_recovery($loginRaw) {
    $login = trim((string)$loginRaw);
    if ($login === '') return null;
    $users = init_users_if_empty();
    foreach ($users as $u) {
        if (user_matches_login($u, $login)) {
            return $u;
        }
    }
    $waNorm = normalize_whatsapp_number($login);
    if (strlen($waNorm) >= 10) {
        foreach ($users as $u) {
            $uWa = normalize_whatsapp_number($u['phone'] ?? '');
            if ($uWa !== '' && $uWa === $waNorm) {
                return $u;
            }
        }
    }
    return null;
}

if ($route === 'forgot_password' && $method === 'POST') {
    $body = get_json_body();
    $login = trim((string)($body['login'] ?? ($body['email'] ?? '')));
    $channel = strtolower(trim((string)($body['channel'] ?? 'both')));
    if (!in_array($channel, ['both', 'email', 'whatsapp'], true)) $channel = 'both';
    if ($login === '') {
        json_out(['ok' => false, 'error' => 'Informe seu usuario, e-mail ou WhatsApp cadastrado.'], 400);
    }
    $ip = get_client_ip();
    $rl = check_rate_limit('forgot_ip', $ip, 5, 900);
    if (!$rl['allowed']) {
        header('Retry-After: ' . max(1, (int)$rl['retry_after']));
        json_out(['ok' => false, 'error' => 'Muitas solicitacoes de recuperacao. Aguarde alguns minutos e tente novamente.'], 429);
    }
    record_rate_limit_hit('forgot_ip', $ip, 900);
    $found = find_user_for_recovery($login);
    if (!$found) {
        json_out(['ok' => false, 'error' => 'Nenhum usuario encontrado com este login, e-mail ou WhatsApp.'], 404);
    }
    if (empty($found['active'])) {
        json_out(['ok' => false, 'error' => 'Esta conta esta desativada. Contate o administrador.'], 403);
    }

    $code = (string)random_int(100000, 999999);
    $tokens = read_json_file(RESET_TOKENS_FILE, []);
    $now = time();
    foreach ($tokens as $tk => $tv) {
        if (($tv['expires_at'] ?? 0) < $now) unset($tokens[$tk]);
    }
    $tokens[$found['id']] = [
        'code' => $code,
        'expires_at' => $now + 900,
        'attempts' => 0
    ];
    write_json_file(RESET_TOKENS_FILE, $tokens);

    $userName = $found['name'] ?? 'Usuario';
    $userLogin = $found['email'] ?? ($found['username'] ?? '');
    $targetEmail = get_user_contact_email($found);
    $targetPhone = trim((string)($found['phone'] ?? ''));

    $waMsg = "🔐 *Recuperação de Senha — ServLynx Explorer*\n\n"
        . "Olá, *{$userName}*!\n"
        . "👤 *Usuário / Login:* {$userLogin}\n"
        . "🔢 *Código de Recuperação (6 dígitos):* *{$code}* _(válido por 15 min)_\n\n"
        . "Digite este código na tela \"Esqueci minha senha\" em https://servlynx.lynxems.com.br para definir uma nova senha.";

    $htmlMsg = '<div style="font-family:Segoe UI,Arial,sans-serif;background:#f3f4f8;padding:24px;color:#0f172a">'
        . '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">'
        . '<div style="background:#0067c0;color:#fff;padding:16px 22px"><h2 style="margin:0;font-size:18px">Recuperação de Acesso — ServLynx</h2></div>'
        . '<div style="padding:20px 22px;font-size:14px;line-height:1.5">'
        . '<p style="margin-top:0">Olá, <strong>' . htmlspecialchars($userName, ENT_QUOTES, 'UTF-8') . '</strong>!</p>'
        . '<p>Recebemos uma solicitação de recuperação de senha para sua conta:</p>'
        . '<table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #cbd5e1">'
        . '<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#475569">Usuário / Login</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"><strong>' . htmlspecialchars($userLogin, ENT_QUOTES, 'UTF-8') . '</strong></td></tr>'
        . '<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#475569">Código de Recuperação</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0"><span style="font-size:20px;font-weight:700;letter-spacing:3px;color:#0067c0">' . htmlspecialchars($code, ENT_QUOTES, 'UTF-8') . '</span> <span style="font-size:12px;color:#64748b">(15 min)</span></td></tr>'
        . '</table>'
        . '<p style="margin:16px 0 0;font-size:12.5px;color:#64748b">Informe este código na tela "Esqueci minha senha" em https://servlynx.lynxems.com.br para definir uma nova senha.</p>'
        . '</div></div></div>';

    if ($targetEmail === '' && $targetPhone === '') {
        $cfg = get_notify_config();
        $supEmail = $cfg['smtp_user'] ?? 'suporte@lynxems.com.br';
        $supWa = $cfg['support_whatsapp'] ?? '553171094030';
        $supText = "⚠️ *Solicitação de Recuperação de Senha (ServLynx)*\n\nO usuário *{$userName}* (`{$userLogin}`) solicitou recuperação de senha, porém não possui e-mail/WhatsApp cadastrado.\n🔢 Código gerado: *{$code}*";
        @send_servlynx_email($supEmail, "Recuperacao de senha solicitada: {$userName}", '<p>' . nl2br(htmlspecialchars($supText, ENT_QUOTES, 'UTF-8')) . '</p>');
        @send_servlynx_whatsapp($supWa, $supText);
        json_out([
            'ok' => true,
            'notified_support' => true,
            'sent_email' => false,
            'sent_whatsapp' => false,
            'message' => 'Sua conta nao possui e-mail ou WhatsApp cadastrado. O suporte Lynx foi notificado automaticamente com seu codigo de recuperacao.'
        ]);
    }

    $sentEmail = false;
    $sentWa = false;
    $errors = [];

    if ($targetEmail !== '' && $channel !== 'whatsapp') {
        $er = send_servlynx_email($targetEmail, 'Recuperacao de Senha — ServLynx Explorer', $htmlMsg);
        if (!empty($er['ok'])) $sentEmail = true;
        else $errors[] = 'E-mail: ' . ($er['error'] ?? 'falha');
    }
    if ($targetPhone !== '' && $channel !== 'email') {
        $wr = send_servlynx_whatsapp($targetPhone, $waMsg);
        if (!empty($wr['ok'])) $sentWa = true;
        else $errors[] = 'WhatsApp: ' . ($wr['error'] ?? 'falha');
    }

    if (!$sentEmail && !$sentWa) {
        $errDetail = count($errors) ? implode(' | ', $errors) : 'Nenhum canal compativel cadastrado nesta conta.';
        json_out(['ok' => false, 'error' => 'Nao foi possivel enviar a recuperacao: ' . $errDetail], 502);
    }

    $via = [];
    if ($sentEmail) $via[] = 'E-mail';
    if ($sentWa) $via[] = 'WhatsApp';
    json_out([
        'ok' => true,
        'sent_email' => $sentEmail,
        'sent_whatsapp' => $sentWa,
        'message' => 'Codigo e dados de acesso enviados via ' . implode(' e ', $via) . '!'
    ]);
}

if ($route === 'reset_password' && $method === 'POST') {
    $body = get_json_body();
    $login = trim((string)($body['login'] ?? ($body['email'] ?? '')));
    $code = trim((string)($body['code'] ?? ''));
    $newPass = (string)($body['new_password'] ?? '');

    if (!$login || !$code || strlen($newPass) < 8) {
        json_out(['ok' => false, 'error' => 'Informe usuario/login, o codigo de 6 digitos e a nova senha (min. 8 caracteres).'], 400);
    }
    $found = find_user_for_recovery($login);
    if (!$found) {
        json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 404);
    }

    $tokens = read_json_file(RESET_TOKENS_FILE, []);
    $tok = $tokens[$found['id']] ?? null;
    if (!is_array($tok) || ($tok['expires_at'] ?? 0) < time()) {
        unset($tokens[$found['id']]);
        write_json_file(RESET_TOKENS_FILE, $tokens);
        json_out(['ok' => false, 'error' => 'Codigo expirado ou nao solicitado. Solicite um novo codigo.'], 400);
    }
    $tok['attempts'] = (int)($tok['attempts'] ?? 0) + 1;
    if ($tok['attempts'] > 5) {
        unset($tokens[$found['id']]);
        write_json_file(RESET_TOKENS_FILE, $tokens);
        json_out(['ok' => false, 'error' => 'Muitas tentativas incorretas. Solicite um novo codigo.'], 429);
    }
    if (!hash_equals((string)$tok['code'], $code)) {
        $tokens[$found['id']] = $tok;
        write_json_file(RESET_TOKENS_FILE, $tokens);
        json_out(['ok' => false, 'error' => 'Codigo de recuperacao incorreto.'], 400);
    }

    unset($tokens[$found['id']]);
    write_json_file(RESET_TOKENS_FILE, $tokens);

    $users = init_users_if_empty();
    $updated = null;
    foreach ($users as &$u) {
        if ($u['id'] === $found['id']) {
            $u['password_hash'] = hash_password_portable($newPass);
            $u['password_enc'] = encrypt_password_reversible($newPass);
            $u['updated_at'] = date('c');
            $updated = $u;
            break;
        }
    }
    unset($u);
    write_json_file(USERS_FILE, $users);
    revoke_user_sessions($found['id']);
    ensure_user_dav_key($found['id'], true);

    if ($updated && !empty($updated['nas_username'])) {
        call_qnap_bridge('change_qnap_password', [
            'username' => $updated['nas_username'],
            'password' => $newPass
        ], 15);
    }
    json_out(['ok' => true, 'message' => 'Senha redefinida com sucesso! Voce ja pode fazer login.']);
}

if ($route === 'change_password_public' && $method === 'POST') {
    $body = get_json_body();
    $login = trim((string)($body['login'] ?? ($body['email'] ?? '')));
    $currentPass = (string)($body['current_password'] ?? '');
    $newPass = (string)($body['new_password'] ?? '');
    if (!$login || !$currentPass) {
        json_out(['ok' => false, 'error' => 'Informe usuario/e-mail e sua senha atual.'], 400);
    }
    if (strlen($newPass) < 8) {
        json_out(['ok' => false, 'error' => 'A nova senha deve ter no minimo 8 caracteres.'], 400);
    }
    $ip = get_client_ip();
    $rlKey = $ip . '|' . strtolower($login);
    $rl = check_rate_limit('change_pw', $rlKey, 6, 900);
    $rlIp = check_rate_limit('change_pw_ip', $ip, 40, 900);
    if (!$rl['allowed'] || !$rlIp['allowed']) {
        $retry = max((int)($rl['retry_after'] ?? 0), (int)($rlIp['retry_after'] ?? 0));
        header('Retry-After: ' . max(1, $retry));
        json_out(['ok' => false, 'error' => 'Muitas tentativas de alteracao de senha. Aguarde alguns minutos.'], 429);
    }
    $authRes = find_authenticated_user($login, $currentPass);
    if (!$authRes || empty($authRes['user'])) {
        if (($authRes['code'] ?? 401) === 401) {
            record_rate_limit_hit('change_pw', $rlKey, 900);
            record_rate_limit_hit('change_pw_ip', $ip, 900);
        }
        json_out(['ok' => false, 'error' => $authRes['error'] ?? 'Usuario ou senha atual incorretos.'], $authRes['code'] ?? 401);
    }
    clear_rate_limit('change_pw', $rlKey);
    $targetUser = $authRes['user'];
    $users = init_users_if_empty();
    $updated = null;
    foreach ($users as &$u) {
        if ($u['id'] === $targetUser['id']) {
            $u['password_hash'] = hash_password_portable($newPass);
            $u['password_enc'] = encrypt_password_reversible($newPass);
            $u['updated_at'] = date('c');
            $updated = $u;
            break;
        }
    }
    unset($u);
    write_json_file(USERS_FILE, $users);
    revoke_user_sessions($targetUser['id']);
    ensure_user_dav_key($targetUser['id'], true);

    if ($updated && !empty($updated['nas_username'])) {
        call_qnap_bridge('change_qnap_password', [
            'username' => $updated['nas_username'],
            'password' => $newPass
        ], 15);
    }
    json_out(['ok' => true, 'message' => 'Senha alterada com sucesso no ServLynx e no QNAP!']);
}

// A partir daqui todas as rotas exigem autenticacao
$auth = require_auth();
$currentUser = $auth['user'];

if ($route === 'me') {
    json_out([
        'ok' => true,
        'user' => sanitize_user_public($currentUser),
        'bridge_online' => is_bridge_online()
    ]);
}

if ($route === 'update_profile' && $method === 'POST') {
    $body = get_json_body();
    $currentPass = (string)($body['current_password'] ?? '');
    $newName = trim((string)($body['name'] ?? ($currentUser['name'] ?? '')));
    $newEmail = trim((string)($body['email'] ?? ($body['username'] ?? ($currentUser['email'] ?? ''))));
    $newPass = (string)($body['new_password'] ?? '');

    if (!$currentPass || !verify_password_portable($currentPass, $currentUser['password_hash'] ?? '')) {
        json_out(['ok' => false, 'error' => 'Senha atual incorreta.'], 403);
    }
    if (!$newName || !$newEmail) {
        json_out(['ok' => false, 'error' => 'Nome e login/e-mail nao podem ficar vazios.'], 400);
    }
    if ($newPass !== '' && strlen($newPass) < 8) {
        json_out(['ok' => false, 'error' => 'A nova senha deve ter no minimo 8 caracteres.'], 400);
    }

    $users = init_users_if_empty();
    foreach ($users as $other) {
        if ($other['id'] !== $currentUser['id']) {
            if (strcasecmp($other['email'] ?? '', $newEmail) === 0 || strcasecmp($other['username'] ?? '', $newEmail) === 0) {
                json_out(['ok' => false, 'error' => 'Este login/e-mail ja esta em uso por outro usuario.'], 409);
            }
        }
    }

    $updated = null;
    foreach ($users as &$u) {
        if ($u['id'] === $currentUser['id']) {
            $u['name'] = $newName;
            $u['email'] = $newEmail;
            $u['username'] = $newEmail;
            if (array_key_exists('phone', $body)) {
                $u['phone'] = trim((string)$body['phone']);
            }
            if (array_key_exists('notify_email', $body)) {
                $u['notify_email'] = trim((string)$body['notify_email']);
            }
            if ($newPass !== '') {
                $u['password_hash'] = hash_password_portable($newPass);
                $u['password_enc'] = encrypt_password_reversible($newPass);
            } else {
                $u['password_enc'] = encrypt_password_reversible($currentPass);
            }
            $u['updated_at'] = date('c');
            $updated = $u;
            break;
        }
    }
    unset($u);

    if (!$updated) {
        json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 404);
    }
    write_json_file(USERS_FILE, $users);

    if ($newPass !== '') {
        revoke_user_sessions($updated['id'], $auth['token'] ?? '');
        ensure_user_dav_key($updated['id'], true);
    }
    if ($newPass !== '' && !empty($updated['nas_username'])) {
        call_qnap_bridge('change_qnap_password', [
            'username' => $updated['nas_username'],
            'password' => $newPass
        ], 15);
    }

    json_out([
        'ok' => true,
        'user' => sanitize_user_public($updated)
    ]);
}

if ($route === 'connect_qnap') {
    $t0 = microtime(true);
    $dirRes = call_qnap_bridge('list_dir', ['path' => '/', 'show_hidden' => false], 18);
    $stRes = !empty($dirRes['ok']) ? call_qnap_bridge('qnap_status', [], 18) : ['ok' => false];
    $latencyMs = (int)round((microtime(true) - $t0) * 1000);
    $state = read_json_file(STATE_FILE, []);
    $shares = [];
    if (!empty($dirRes['ok'])) {
        $shares = filter_items_for_user($currentUser, '/', $dirRes['items'] ?? []);
        $state['last_heartbeat'] = time();
        $state['root_items'] = $dirRes['items'] ?? ($state['root_items'] ?? []);
        if (!empty($stRes['ok']) && !empty($stRes['status'])) {
            $state['qnap_status'] = $stRes['status'];
        }
        write_json_file(STATE_FILE, $state);
    }
    $qStatus = !empty($stRes['ok']) ? ($stRes['status'] ?? null) : ($state['qnap_status'] ?? null);
    if (($currentUser['role'] ?? '') !== 'admin' && empty($currentUser['permissions']['manage_qnap'])) {
        $qStatus = $qStatus ? [
            'model' => $qStatus['model'] ?? 'TS-231P',
            'hostname' => $qStatus['hostname'] ?? 'NAS09534B',
            'disk' => $qStatus['disk'] ?? null
        ] : null;
    }
    json_out([
        'ok' => !empty($dirRes['ok']),
        'bridge_online' => !empty($dirRes['ok']) || is_bridge_online(),
        'latency_ms' => $latencyMs,
        'shares_count' => count($shares),
        'shares' => $shares,
        'status' => $qStatus,
        'error' => $dirRes['error'] ?? null
    ], !empty($dirRes['ok']) ? 200 : 502);
}

if ($route === 'tutorial_video') {
    $videoPath = DATA_DIR . '/tutorial_instalar_drive.mp4';
    if (!file_exists($videoPath)) {
        json_out(['ok' => false, 'error' => 'Video tutorial ainda nao publicado.'], 404);
    }
    $inline = empty($_GET['download']);
    serve_file_with_range($videoPath, 'video/mp4', 'Tutorial_Instalar_Drive_ServLynx.mp4', $inline, false);
}

if ($route === 'rotate_dav_key' && $method === 'POST') {
    require_permission($currentUser, 'read');
    $newKey = ensure_user_dav_key($currentUser['id'], true);
    json_out([
        'ok' => true,
        'dav_key' => $newKey
    ]);
}

function slx_bat_escape($str) {
    $s = str_replace(["\r", "\n", '"', '^', '&', '|', '<', '>', '`', '(', ')'], '', (string)$str);
    return str_replace('%', '%%', $s);
}

function slx_utf16le_base64(string $utf8): string {
    if (function_exists('mb_convert_encoding')) {
        return base64_encode(mb_convert_encoding($utf8, 'UTF-16LE', 'UTF-8'));
    }
    if (function_exists('iconv')) {
        $bin = iconv('UTF-8', 'UTF-16LE//IGNORE', $utf8);
        if ($bin !== false) return base64_encode($bin);
    }
    $out = '';
    $len = strlen($utf8);
    for ($i = 0; $i < $len; $i++) {
        $out .= $utf8[$i] . "\x00";
    }
    return base64_encode($out);
}

function slx_open_local_ps_script(): string {
    return <<<'PSCODE'
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms | Out-Null

function Show-SlxMsg([string]$msg, [bool]$isErr = $true) {
  $icon = if ($isErr) { [System.Windows.Forms.MessageBoxIcon]::Warning } else { [System.Windows.Forms.MessageBoxIcon]::Information }
  [System.Windows.Forms.MessageBox]::Show($msg, "ServLynx Explorer - Abrir no Drive Local", [System.Windows.Forms.MessageBoxButtons]::OK, $icon) | Out-Null
}

$rawArg = if ($args.Count -gt 0) { [string]$args[0] } else { "" }
if (-not $rawArg) { exit 0 }

$qPart = ""
$qIdx = $rawArg.IndexOf('?')
if ($qIdx -ge 0) { $qPart = $rawArg.Substring($qIdx + 1) }
$qPart = $qPart.TrimEnd('/')

$reqPath = ""
$prefLtr = ""
foreach ($pair in ($qPart -split '&')) {
  if (-not $pair) { continue }
  $kv = $pair.Split('=', 2)
  $k = [System.Uri]::UnescapeDataString($kv[0]).ToLowerInvariant()
  $v = if ($kv.Count -gt 1) { [System.Uri]::UnescapeDataString($kv[1]) } else { "" }
  if ($k -eq "path") { $reqPath = $v }
  elseif ($k -eq "letter") { $prefLtr = $v.ToUpperInvariant() }
}

if (-not $reqPath) { Show-SlxMsg "Caminho do arquivo nao informado no link ServLynx."; exit 1 }
if ($reqPath -match '[\:\|\&\;\`\$<>"''\\]' -or $reqPath -match '(^|/)\.\.(/|$)') {
  Show-SlxMsg "Caminho bloqueado por seguranca: $reqPath"; exit 1
}
$reqPath = "/" + (($reqPath -replace '/+', '/').Trim('/'))

$dir = Join-Path $env:LOCALAPPDATA "ServLynxDrive"
$mountsFile = Join-Path $dir "mounts.json"
$mounts = @{}
if (Test-Path -LiteralPath $mountsFile) {
  try {
    $rawJson = Get-Content -LiteralPath $mountsFile -Raw -Encoding UTF8
    if ($rawJson) {
      $obj = $rawJson | ConvertFrom-Json
      foreach ($p in $obj.PSObject.Properties) {
        $mounts[$p.Name.ToUpperInvariant()] = [string]$p.Value
      }
    }
  } catch {}
}

$chosenLtr = ""
$bestPrefix = ""
$bestLen = -1
foreach ($k in $mounts.Keys) {
  if ($k -notmatch '^[E-Z]$') { continue }
  $pfx = "/" + (($mounts[$k] -replace '\\', '/' -replace '/+', '/').Trim('/'))
  $isMatch = ($pfx -eq "/") -or $reqPath.Equals($pfx, [System.StringComparison]::OrdinalIgnoreCase) -or $reqPath.StartsWith(($pfx + "/"), [System.StringComparison]::OrdinalIgnoreCase)
  if ($isMatch -and $pfx.Length -gt $bestLen) {
    $chosenLtr = $k
    $bestPrefix = $pfx
    $bestLen = $pfx.Length
  }
}

$relSub = ""
if ($chosenLtr) {
  if ($bestPrefix -eq "/") {
    $relSub = $reqPath.TrimStart('/')
  } elseif ($reqPath.Equals($bestPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    $relSub = ""
  } else {
    $relSub = $reqPath.Substring($bestPrefix.Length).TrimStart('/')
  }
} elseif ($prefLtr -match '^[E-Z]$' -and ((Test-Path -LiteralPath ($prefLtr + ":\")) -or (Test-Path -LiteralPath (Join-Path $dir ("reconectar_" + $prefLtr + ".cmd"))))) {
  $chosenLtr = $prefLtr
  $relSub = $reqPath.TrimStart('/')
} else {
  Show-SlxMsg ("Nenhum drive ServLynx mapeado nesta maquina cobre a pasta '" + $reqPath + "'." + "`r`n`r`nNo portal web, clique em 'Instalar Drive (PC)' para mapear a pasta uma unica vez.")
  exit 1
}

$driveRoot = $chosenLtr + ":\"
if (-not (Test-Path -LiteralPath $driveRoot)) {
  $reCmd = Join-Path $dir ("reconectar_" + $chosenLtr + ".cmd")
  if (Test-Path -LiteralPath $reCmd) {
    Start-Process -FilePath "cmd.exe" -ArgumentList @('/c', $reCmd) -WindowStyle Hidden -Wait
    $tries = 0
    while (-not (Test-Path -LiteralPath $driveRoot) -and $tries -lt 6) {
      Start-Sleep -Milliseconds 500
      $tries++
    }
  }
}

if (-not (Test-Path -LiteralPath $driveRoot)) {
  Show-SlxMsg ("A unidade " + $driveRoot + " nao esta acessivel no momento. Verifique sua internet e execute o instalador do Drive pelo portal.")
  exit 1
}

$winSub = ($relSub -replace '/', '\').TrimStart('\')
$fullPath = if ($winSub) { Join-Path $driveRoot $winSub } else { $driveRoot }
$resolved = [System.IO.Path]::GetFullPath($fullPath)
if (-not $resolved.StartsWith($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Show-SlxMsg "Caminho invalido fora da unidade mapeada."; exit 1
}

if (-not (Test-Path -LiteralPath $resolved)) {
  Start-Sleep -Milliseconds 700
}
if (-not (Test-Path -LiteralPath $resolved)) {
  Show-SlxMsg ("Item nao encontrado em " + $driveRoot + ":" + "`r`n" + $resolved + "`r`n`r`nDica: confira se o drive " + $chosenLtr + ": foi mapeado para a pasta correta.")
  exit 1
}

Start-Process -FilePath $resolved
PSCODE;
}

function slx_ps_postmount_code(string $psPayload): string {
    $openLocalPsB64 = slx_utf16le_base64(slx_open_local_ps_script());
    return implode("\r\n", [
        '$ProgressPreference = "SilentlyContinue"',
        "\$d = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{$psPayload}')) | ConvertFrom-Json",
        '$ltr = $d.letter',
        '$prov = (Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -eq ($ltr + ":") } | Select-Object -First 1 -ExpandProperty ProviderName)',
        '$mpKeys = New-Object System.Collections.Generic.List[string]',
        'if ($prov) { $mpKeys.Add(($prov -replace "\\\\", "#")) }',
        'if ($d.mode -eq "webdav" -and $d.unc) {',
        '  $mpKeys.Add(($d.unc -replace "\\\\", "#"))',
        '  $mpKeys.Add((($d.unc -replace "\\\\DavWWWRoot", "") -replace "\\\\", "#"))',
        '}',
        'foreach ($mk in ($mpKeys | Select-Object -Unique)) {',
        '  if ($mk) {',
        '    $mpPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\MountPoints2\" + $mk',
        '    if (-not (Test-Path $mpPath)) { New-Item -Path $mpPath -Force -ErrorAction SilentlyContinue | Out-Null }',
        '    Set-ItemProperty -Path $mpPath -Name "_LabelFromReg" -Value $d.label -Type String -Force -ErrorAction SilentlyContinue',
        '  }',
        '}',
        '$dir = Join-Path $env:LOCALAPPDATA "ServLynxDrive"',
        'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
        '$mountsFile = Join-Path $dir "mounts.json"',
        '$mounts = @{}',
        'if (Test-Path -LiteralPath $mountsFile) {',
        '  try {',
        '    $mObj = Get-Content -LiteralPath $mountsFile -Raw -Encoding UTF8 | ConvertFrom-Json',
        '    foreach ($p in $mObj.PSObject.Properties) { $mounts[$p.Name.ToUpperInvariant()] = [string]$p.Value }',
        '  } catch {}',
        '}',
        '$mounts[$ltr] = [string]$d.target_path',
        '[System.IO.File]::WriteAllText($mountsFile, ($mounts | ConvertTo-Json -Depth 3), [System.Text.Encoding]::UTF8)',
        '$openPsPath = Join-Path $dir "abrir_local.ps1"',
        "\$openPsTxt = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{$openLocalPsB64}'))",
        '[System.IO.File]::WriteAllText($openPsPath, $openPsTxt, [System.Text.Encoding]::UTF8)',
        '$openVbsPath = Join-Path $dir "abrir_local.vbs"',
        '$openVbsTxt = "Set args = WScript.Arguments" + "`r`n" + "u = """"" + "`r`n" + "If args.Count > 0 Then u = args(0)" + "`r`n" + "cmd = ""powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """"" + $openPsPath + """"" """""" & u & """"""""" + "`r`n" + "CreateObject(""WScript.Shell"").Run cmd, 0, False"',
        '[System.IO.File]::WriteAllText($openVbsPath, $openVbsTxt, [System.Text.Encoding]::ASCII)',
        '& reg.exe add "HKCU\Software\Classes\servlynx" /ve /t REG_SZ /d "URL:ServLynx Local Drive Protocol" /f 2>&1 | Out-Null',
        '& reg.exe add "HKCU\Software\Classes\servlynx" /v "URL Protocol" /t REG_SZ /d "" /f 2>&1 | Out-Null',
        '& reg.exe add "HKCU\Software\Classes\servlynx\DefaultIcon" /ve /t REG_SZ /d "imageres.dll,-27" /f 2>&1 | Out-Null',
        '& reg.exe add "HKCU\Software\Classes\servlynx\shell\open\command" /ve /t REG_SZ /d ("wscript.exe """ + $openVbsPath + """ ""%1""") /f 2>&1 | Out-Null',
        '$unBat = Join-Path $dir ("desinstalar_" + $ltr + ".bat")',
        '$startVbs = Join-Path ([Environment]::GetFolderPath("Startup")) ("ServLynx_Drive_" + $ltr + ".vbs")',
        '$reCmd = Join-Path $dir ("reconectar_" + $ltr + ".cmd")',
        '$deskDir = [Environment]::GetFolderPath("Desktop")',
        '$unLnkGlob = Join-Path $deskDir ("* (" + $ltr + ").lnk")',
        '$uLines = @(',
        '  "@echo off",',
        '  "chcp 65001 >nul",',
        '  ("net use " + $ltr + ": /delete /y"),',
        '  ("del /q """ + $startVbs + """ >nul 2>&1"),',
        '  ("del /q """ + $reCmd + """ >nul 2>&1"),',
        '  ("del /q """ + $unLnkGlob + """ >nul 2>&1"),',
        '  ("echo Drive " + $ltr + ": desinstalado com sucesso."),',
        '  "if /i not ""%SLX_NO_PAUSE%""==""1"" pause"',
        ')',
        '[System.IO.File]::WriteAllLines($unBat, $uLines, [System.Text.Encoding]::ASCII)',
        'if ($d.mode -eq "smb") {',
        '  $mountLines = @(',
        '    "@echo off",',
        '    ("net use " + $ltr + ": /delete /y >nul 2>&1"),',
        '    ("net use " + $ltr + ": """ + $d.smb + """ /persistent:yes >nul 2>&1")',
        '  )',
        '} else {',
        '  $uBat = ($d.url -replace "%", "%%")',
        '  $mountLines = @(',
        '    "@echo off",',
        '    ("net use " + $ltr + ": /delete /y >nul 2>&1"),',
        '    "cmdkey /delete:servlynx.lynxems.com.br >nul 2>&1",',
        '    ("cmdkey /add:servlynx.lynxems.com.br /user:""" + $d.login + """ /pass:""" + $d.key + """ >nul 2>&1"),',
        '    ("net use " + $ltr + ": """ + $uBat + """ /user:""" + $d.login + """ """ + $d.key + """ /persistent:yes >nul 2>&1"),',
        '    "if not errorlevel 1 goto SLX_RECONN_END",',
        '    ("net use " + $ltr + ": """ + $d.unc + """ /user:""" + $d.login + """ """ + $d.key + """ /persistent:yes >nul 2>&1"),',
        '    ":SLX_RECONN_END"',
        '  )',
        '}',
        'if ($d.autostart) {',
        '  [System.IO.File]::WriteAllLines($reCmd, $mountLines, [System.Text.Encoding]::ASCII)',
        '  $vbsTxt = "CreateObject(""WScript.Shell"").Run """"""" + $reCmd + """"""", 0, False"',
        '  [System.IO.File]::WriteAllText($startVbs, $vbsTxt, [System.Text.Encoding]::ASCII)',
        '} else {',
        '  Remove-Item -Path $startVbs, $reCmd -Force -ErrorAction SilentlyContinue',
        '}',
        '$isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        'if ($isAdmin) {',
        '  $onceCmd = Join-Path $dir ("_mount_once_" + $ltr + ".cmd")',
        '  $onceVbs = Join-Path $dir ("_mount_once_" + $ltr + ".vbs")',
        '  [System.IO.File]::WriteAllLines($onceCmd, $mountLines, [System.Text.Encoding]::ASCII)',
        '  $ovTxt = "CreateObject(""WScript.Shell"").Run """"""" + $onceCmd + """"""", 0, True"',
        '  [System.IO.File]::WriteAllText($onceVbs, $ovTxt, [System.Text.Encoding]::ASCII)',
        '  $tn = "ServLynxMountOnce_" + $ltr',
        '  & schtasks.exe /Create /TN $tn /SC ONCE /ST 00:00 /TR ("wscript.exe """ + $onceVbs + """") /F 2>&1 | Out-Null',
        '  & schtasks.exe /Run /TN $tn 2>&1 | Out-Null',
        '  Start-Sleep -Seconds 3',
        '  & schtasks.exe /Delete /TN $tn /F 2>&1 | Out-Null',
        '  Remove-Item -Path $onceVbs, $onceCmd -Force -ErrorAction SilentlyContinue',
        '}',
        'if ($d.shortcut) {',
        '  $lnk = Join-Path $deskDir ($d.file_label + " (" + $ltr + ").lnk")',
        '  $ws = New-Object -ComObject WScript.Shell',
        '  $sc = $ws.CreateShortcut($lnk)',
        '  $sc.TargetPath = ($ltr + ":\\")',
        '  $sc.Description = $d.label',
        '  $sc.IconLocation = "imageres.dll,-27"',
        '  $sc.Save()',
        '}'
    ]);
}

if ($route === 'drive_installer') {
    require_permission($currentUser, 'read');

    $rawPath = trim((string)($_GET['path'] ?? ''));
    if ($rawPath === '' && !empty($_GET['share'])) {
        $legacyShare = preg_replace('/[^a-zA-Z0-9_\-\s]/', '', trim((string)$_GET['share']));
        $rawPath = $legacyShare !== '' ? '/' . $legacyShare : '/';
    }
    $targetPath = normalize_rel_path($rawPath !== '' ? $rawPath : '/');
    $targetPath = assert_path_allowed($currentUser, $targetPath, 'list');

    $letter = strtoupper(preg_replace('/[^a-zA-Z]/', '', (string)($_GET['letter'] ?? 'L')));
    if (!preg_match('/^[E-Z]$/', $letter)) {
        $letter = 'L';
    }

    $action = strtolower(trim((string)($_GET['action'] ?? 'mount')));
    if (!in_array($action, ['mount', 'unmount'], true)) {
        $action = 'mount';
    }

    $mode = strtolower(trim((string)($_GET['mode'] ?? 'webdav')));
    if (!in_array($mode, ['webdav', 'smb'], true)) {
        $mode = 'webdav';
    }

    $format = strtolower(trim((string)($_GET['format'] ?? 'bat')));
    if (!in_array($format, ['bat', 'ps1'], true)) {
        $format = 'bat';
    }

    $desktopShortcut = !isset($_GET['desktop_shortcut']) || !in_array(strtolower((string)$_GET['desktop_shortcut']), ['0', 'false', 'no'], true);
    $autostart = !isset($_GET['autostart']) || !in_array(strtolower((string)$_GET['autostart']), ['0', 'false', 'no'], true);

    $rawLabel = trim((string)($_GET['label'] ?? ''));
    if ($rawLabel === '') {
        $rawLabel = ($targetPath === '/') ? 'ServLynx NAS' : ('ServLynx - ' . basename($targetPath));
    }
    $cleanLabel = trim(preg_replace('/[\r\n"<>|]+/', '', $rawLabel));
    if ($cleanLabel === '') {
        $cleanLabel = 'ServLynx Drive';
    }

    $slugBase = ($targetPath === '/') ? 'Raiz' : basename($targetPath);
    $slug = trim((string)preg_replace('/[^a-zA-Z0-9_\-]+/', '_', $slugBase), '_');
    if ($slug === '') $slug = 'Pasta';

    if ($action === 'unmount') {
        $psPayload = base64_encode(json_encode([
            'letter' => $letter,
            'label' => $cleanLabel
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

        $unmountPs = implode("\r\n", [
            '$ProgressPreference = "SilentlyContinue"',
            "\$d = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{$psPayload}')) | ConvertFrom-Json",
            '$l = $d.letter',
            '$desk = [Environment]::GetFolderPath("Desktop")',
            'Get-ChildItem -Path $desk -Filter ("*(" + $l + ").lnk") -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue',
            '$st = Join-Path ([Environment]::GetFolderPath("Startup")) ("ServLynx_Drive_" + $l + ".vbs")',
            '$dir = Join-Path $env:LOCALAPPDATA "ServLynxDrive"',
            '$mf = Join-Path $dir "mounts.json"',
            'if (Test-Path -LiteralPath $mf) { try { $o = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json; $m = @{}; foreach ($p in $o.PSObject.Properties) { if ($p.Name -ne $l) { $m[$p.Name] = [string]$p.Value } }; [System.IO.File]::WriteAllText($mf, ($m | ConvertTo-Json -Depth 3), [System.Text.Encoding]::UTF8) } catch {} }',
            'Remove-Item -Path $st, (Join-Path $dir ("reconectar_" + $l + ".cmd")), (Join-Path $dir ("desinstalar_" + $l + ".bat")) -Force -ErrorAction SilentlyContinue'
        ]);
        $unmountB64 = slx_utf16le_base64($unmountPs);

        $batLines = [
            '@echo off',
            'chcp 65001 >nul',
            "title ServLynx Explorer - Desinstalar Drive {$letter}:",
            'echo =======================================================',
            "echo   ServLynx Explorer - Remover Drive e Inicializacao {$letter}:",
            'echo =======================================================',
            "net use {$letter}: /delete /y >nul 2>&1",
            "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {$unmountB64}",
            'echo.',
            "echo Unidade {$letter}: e atalho de inicializacao removidos com sucesso.",
            'if /i not "%SLX_NO_PAUSE%"=="1" pause',
            'exit /b 0'
        ];
        $bat = implode("\r\n", $batLines) . "\r\n";
        header('Content-Type: application/octet-stream');
        header("Content-Disposition: attachment; filename=\"Desinstalar_Drive_{$letter}.bat\"");
        header('Content-Length: ' . strlen($bat));
        header('Cache-Control: no-store');
        echo $bat;
        exit;
    }

    $davKey = ensure_user_dav_key($currentUser['id'], false);
    $loginUser = (string)($currentUser['email'] ?? ($currentUser['username'] ?? ''));
    $nasUser = (string)($currentUser['nas_username'] ?? '');

    $segs = ($targetPath === '/') ? [] : explode('/', ltrim($targetPath, '/'));
    $encSegs = array_map('rawurlencode', $segs);
    $davSuffix = count($encSegs) ? ('/' . implode('/', $encSegs)) : '';
    $webdavUrl = 'https://servlynx.lynxems.com.br/dav' . $davSuffix;
    $uncSuffix = count($segs) ? ('\\' . implode('\\', $segs)) : '';
    $webdavUnc = '\\\\servlynx.lynxems.com.br@SSL\\DavWWWRoot\\dav' . $uncSuffix;

    if (count($segs) === 0) {
        $smbShare = 'Public';
        if (!in_array('*', $currentUser['allowed_shares'] ?? [], true) && !empty($currentUser['allowed_shares'][0])) {
            $smbShare = (string)$currentUser['allowed_shares'][0];
        }
        $smbTarget = '\\\\192.168.15.44\\' . $smbShare;
    } else {
        $smbTarget = '\\\\192.168.15.44\\' . implode('\\', $segs);
    }

    $davUrlBat = slx_bat_escape($webdavUrl);
    $davUncBat = slx_bat_escape($webdavUnc);
    $smbBat = slx_bat_escape($smbTarget);
    $loginBat = slx_bat_escape($loginUser);
    $nasBat = slx_bat_escape($nasUser);
    $targetDisplayBat = slx_bat_escape($targetPath);

    $psPayload = base64_encode(json_encode([
        'letter' => $letter,
        'mode' => $mode,
        'target_path' => $targetPath,
        'label' => $cleanLabel,
        'file_label' => trim((string)preg_replace('/[\\\\\/:\*\?"<>\|]+/', '_', $cleanLabel)),
        'shortcut' => $desktopShortcut,
        'autostart' => $autostart,
        'url' => $webdavUrl,
        'unc' => $webdavUnc,
        'smb' => $smbTarget,
        'login' => $loginUser,
        'key' => ($mode === 'webdav') ? $davKey : '',
        'nas_user' => $nasUser
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

    $psPostMount = slx_ps_postmount_code($psPayload);
    $psPostMountB64 = slx_utf16le_base64($psPostMount);

    $regKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters';
    $elevatedWebClientCmd = implode("\r\n", [
        '$ErrorActionPreference = "SilentlyContinue"',
        '$ProgressPreference = "SilentlyContinue"',
        "\$rk = \"{$regKey}\"",
        '& reg.exe add $rk /v ServiceDll /t REG_EXPAND_SZ /d "%SystemRoot%\\System32\\webclnt.dll" /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v ServiceDllUnloadOnStop /t REG_DWORD /d 1 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v AcceptOfficeAndTahoeServers /t REG_DWORD /d 1 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v SupportLocking /t REG_DWORD /d 1 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v LocalServerTimeoutInSec /t REG_DWORD /d 15 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v ServerNotFoundCacheLifeTimeInSec /t REG_DWORD /d 60 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v ClientDebug /t REG_DWORD /d 0 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v ServiceDebug /t REG_DWORD /d 0 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v BasicAuthLevel /t REG_DWORD /d 1 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v FileAttributesLimitInBytes /t REG_DWORD /d 67108864 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v SendReceiveTimeoutInSec /t REG_DWORD /d 300 /f 2>&1 | Out-Null',
        '& reg.exe add $rk /v InternetServerTimeoutInSec /t REG_DWORD /d 120 /f 2>&1 | Out-Null',
        '& sc.exe config WebClient start= auto 2>&1 | Out-Null',
        '& net.exe stop WebClient /y 2>&1 | Out-Null',
        '& net.exe start WebClient 2>&1 | Out-Null'
    ]);
    $elevatedWebClientB64 = slx_utf16le_base64($elevatedWebClientCmd);
    $uacWrapperPs = implode("\r\n", [
        '$ProgressPreference = "SilentlyContinue"',
        'try {',
        "  Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{$elevatedWebClientB64}' | Out-Null",
        '} catch {',
        '  exit 0',
        '}'
    ]);
    $uacWrapperB64 = slx_utf16le_base64($uacWrapperPs);

    if ($format === 'ps1') {
        $psLines = [
            '$ErrorActionPreference = "Continue"',
            "\$d = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{$psPayload}')) | ConvertFrom-Json",
            '$ltr = $d.letter',
            'Write-Host "==============================================================" -ForegroundColor Cyan',
            'Write-Host "  ServLynx Explorer - Instalando Drive ${ltr}: ($($d.label))" -ForegroundColor Cyan',
            'Write-Host "==============================================================" -ForegroundColor Cyan',
            'if ($d.mode -eq "webdav") {',
            '  $svc = Get-Service WebClient -ErrorAction SilentlyContinue',
            '  $regP = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters" -ErrorAction SilentlyContinue',
            '  $needUac = (-not $svc) -or ($svc.Status -ne "Running") -or (-not $regP.ServiceDll) -or ([uint32]$regP.FileSizeLimitInBytes -ne 4294967295) -or ([int]$regP.SendReceiveTimeoutInSec -lt 300)',
            '  if ($needUac -and $env:SLX_SKIP_UAC -ne "1") {',
            '    Write-Host "Configurando servico WebClient (4 GB + timeout 5 min)... Confirme o UAC se solicitado." -ForegroundColor Yellow',
            '    try {',
            "      Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{$elevatedWebClientB64}' | Out-Null",
            '      Start-Sleep -Seconds 2',
            '    } catch {',
            '      Write-Host "Aviso: UAC nao confirmado; tentando montar com configuracao atual." -ForegroundColor Yellow',
            '    }',
            '  }',
            '  & net use "${ltr}:" /delete /y 2>$null | Out-Null',
            '  & cmdkey /delete:servlynx.lynxems.com.br 2>$null | Out-Null',
            '  & cmdkey /add:servlynx.lynxems.com.br ("/user:" + $d.login) ("/pass:" + $d.key) 2>$null | Out-Null',
            '  Write-Host "Conectando via WebDAV Seguro HTTPS..."',
            '  & net use "${ltr}:" "$($d.url)" ("/user:" + $d.login) "$($d.key)" /persistent:yes',
            '  if ($LASTEXITCODE -ne 0) {',
            '    Write-Host "Tentando caminho UNC SSL alternativo..." -ForegroundColor Yellow',
            '    & net use "${ltr}:" "$($d.unc)" ("/user:" + $d.login) "$($d.key)" /persistent:yes',
            '  }',
            '} else {',
            '  & net use "${ltr}:" /delete /y 2>$null | Out-Null',
            '  if ($d.nas_user) { Write-Host "Se o Windows pedir usuario SMB local, use: $($d.nas_user)" -ForegroundColor Yellow }',
            '  & net use "${ltr}:" "$($d.smb)" /persistent:yes',
            '}',
            'if ($LASTEXITCODE -ne 0) { Write-Host "Falha ao mapear unidade ${ltr}:." -ForegroundColor Red; exit 1 }',
            $psPostMount,
            'Write-Host "[OK] Drive ${ltr}: instalado com sucesso! Agora aparece em Este Computador e Abrir/Salvar." -ForegroundColor Green',
            'if ($env:SLX_NO_OPEN_EXPLORER -ne "1") { Start-Process explorer.exe ($ltr + ":\\") }'
        ];
        $psScript = implode("\r\n", $psLines) . "\r\n";
        header('Content-Type: text/plain; charset=utf-8');
        header("Content-Disposition: inline; filename=\"Instalar_Drive_ServLynx_{$letter}_{$slug}.ps1\"");
        header('Content-Length: ' . strlen($psScript));
        header('Cache-Control: no-store');
        echo $psScript;
        exit;
    }

    $batLines = [
        '@echo off',
        'chcp 65001 >nul',
        "title ServLynx Explorer - Instalar Drive {$letter}:",
        'echo ==============================================================',
        "echo   ServLynx Explorer - Instalador do Drive {$letter}: no Windows",
        "echo   Pasta QNAP: {$targetDisplayBat}",
        'echo ==============================================================',
        'echo.',
        "net use {$letter}: /delete /y >nul 2>&1"
    ];

    if ($mode === 'smb') {
        $batLines[] = "echo Conectando na rede local da empresa - QNAP SMB: {$smbBat}";
        if ($nasBat !== '') {
            $batLines[] = "echo Dica: se o Windows pedir usuario de rede, informe: {$nasBat}";
        }
        $batLines[] = "net use {$letter}: \"{$smbBat}\" /persistent:yes";
        $batLines[] = 'if not errorlevel 1 goto MOUNT_OK';
        $batLines[] = 'echo.';
        $batLines[] = 'echo [Aviso] Falha na conexao SMB local. Verifique se voce esta na mesma rede do QNAP ou use o modo WebDAV HTTPS.';
        $batLines[] = 'if /i not "%SLX_NO_PAUSE%"=="1" pause';
        $batLines[] = 'exit /b 1';
    } else {
        $batLines[] = 'set "SLX_NEED_UAC=0"';
        $batLines[] = 'sc query WebClient | find /i "RUNNING" >nul 2>&1';
        $batLines[] = 'if errorlevel 1 set "SLX_NEED_UAC=1"';
        $batLines[] = 'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v ServiceDll 2>nul | find /i "webclnt.dll" >nul 2>&1';
        $batLines[] = 'if errorlevel 1 set "SLX_NEED_UAC=1"';
        $batLines[] = 'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v FileSizeLimitInBytes 2>nul | find /i "0xffffffff" >nul 2>&1';
        $batLines[] = 'if errorlevel 1 set "SLX_NEED_UAC=1"';
        $batLines[] = 'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v SendReceiveTimeoutInSec 2>nul | find /i "0x12c" >nul 2>&1';
        $batLines[] = 'if errorlevel 1 set "SLX_NEED_UAC=1"';
        $batLines[] = 'if /i "%SLX_SKIP_UAC%"=="1" set "SLX_NEED_UAC=0"';
        $batLines[] = 'if not "%SLX_NEED_UAC%"=="1" goto AFTER_UAC';
        $batLines[] = 'echo Configurando WebClient para 4 GB, pastas grandes e timeout de 5 min - confirme o UAC se solicitado...';
        $batLines[] = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {$uacWrapperB64}";
        $batLines[] = 'timeout /t 2 /nobreak >nul';
        $batLines[] = ':AFTER_UAC';
        $batLines[] = 'cmdkey /delete:servlynx.lynxems.com.br >nul 2>&1';
        $batLines[] = "cmdkey /add:servlynx.lynxems.com.br /user:\"{$loginBat}\" /pass:\"{$davKey}\" >nul 2>&1";
        $batLines[] = "echo Conectando unidade {$letter}: via WebDAV Seguro HTTPS...";
        $batLines[] = "net use {$letter}: \"{$davUrlBat}\" /user:\"{$loginBat}\" \"{$davKey}\" /persistent:yes";
        $batLines[] = 'if not errorlevel 1 goto MOUNT_OK';
        $batLines[] = 'echo Tentando endereco UNC SSL alternativo...';
        $batLines[] = "net use {$letter}: \"{$davUncBat}\" /user:\"{$loginBat}\" \"{$davKey}\" /persistent:yes";
        $batLines[] = 'if not errorlevel 1 goto MOUNT_OK';
        $batLines[] = 'echo.';
        $batLines[] = "echo [Erro] Nao foi possivel mapear {$letter}:.";
        $batLines[] = 'echo Verifique sua internet e se o servico WebClient do Windows esta ativo.';
        $batLines[] = 'if /i not "%SLX_NO_PAUSE%"=="1" pause';
        $batLines[] = 'exit /b 1';
    }

    $batLines[] = ':MOUNT_OK';
    $batLines[] = "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {$psPostMountB64}";
    $batLines[] = 'echo.';
    $batLines[] = "echo [OK] Drive {$letter}: instalado com sucesso! Agora ele aparece em Este Computador e em Abrir / Salvar como.";
    $batLines[] = "if /i not \"%SLX_NO_OPEN_EXPLORER%\"==\"1\" start \"\" explorer.exe {$letter}:\\";
    $batLines[] = 'if /i not "%SLX_NO_PAUSE%"=="1" pause';
    $batLines[] = 'exit /b 0';

    $bat = implode("\r\n", $batLines) . "\r\n";
    header('Content-Type: application/octet-stream');
    header("Content-Disposition: attachment; filename=\"Instalar_Drive_ServLynx_{$letter}_{$slug}.bat\"");
    header('Content-Length: ' . strlen($bat));
    header('Cache-Control: no-store');
    echo $bat;
    exit;
}

// ==================== ARQUIVOS & PASTAS (WINDOWS EXPLORER) ====================
if ($route === 'files') {
    $path = assert_path_allowed($currentUser, $_GET['path'] ?? '/', 'list');
    $showHidden = !empty($_GET['hidden']) && (($currentUser['role'] ?? '') === 'admin');
    $dirCacheFile = DATA_DIR . '/dir_cache_' . md5($path . ($showHidden ? '|hidden' : '')) . '.json';
    $effMode = get_effective_path_mode($currentUser, $path);

    $res = call_qnap_bridge('list_dir', [
        'path' => $path,
        'show_hidden' => $showHidden
    ], 18);

    if (empty($res['ok'])) {
        $res = call_qnap_bridge('list_dir', [
            'path' => $path,
            'show_hidden' => $showHidden
        ], 12);
    }

    if (!empty($res['ok'])) {
        write_json_file($dirCacheFile, [
            'path' => $path,
            'items' => $res['items'] ?? [],
            'updated_at' => time()
        ]);
        $res['items'] = filter_items_for_user($currentUser, $path, $res['items'] ?? []);
        $res['path'] = $path;
        $res['access_mode'] = $effMode;
        $res['bridge_online'] = true;
        json_out($res);
    }

    // Fallback para snapshot do diretorio caso o bridge esteja reconectando
    $cachedDir = read_json_file($dirCacheFile, null);
    if (is_array($cachedDir) && isset($cachedDir['items'])) {
        json_out([
            'ok' => true,
            'path' => $path,
            'access_mode' => $effMode,
            'items' => filter_items_for_user($currentUser, $path, $cachedDir['items']),
            'bridge_online' => is_bridge_online(),
            'cached' => true,
            'warning' => $res['error'] ?? null
        ]);
    }
    if ($path === '/') {
        $state = read_json_file(STATE_FILE, []);
        if (!empty($state['root_items'])) {
            json_out([
                'ok' => true,
                'path' => '/',
                'access_mode' => $effMode,
                'items' => filter_items_for_user($currentUser, '/', $state['root_items']),
                'bridge_online' => is_bridge_online(),
                'cached' => true,
                'warning' => $res['error'] ?? null
            ]);
        }
    }
    json_out($res, 502);
}

if ($route === 'mkdir' && $method === 'POST') {
    $body = get_json_body();
    $rawParent = normalize_rel_path($body['path'] ?? '/');
    if ($rawParent === '/') {
        if (($currentUser['role'] ?? '') !== 'admin') {
            json_out(['ok' => false, 'error' => 'Somente administradores podem criar pastas compartilhadas na raiz.'], 403);
        }
        $parent = '/';
    } else {
        $parent = assert_path_allowed($currentUser, $rawParent, 'write');
    }
    $name = trim((string)($body['name'] ?? ''));
    if (!$name || preg_match('/[\/\\\\:*?"<>|]/', $name)) {
        json_out(['ok' => false, 'error' => 'Nome de pasta invalido.'], 400);
    }
    $res = call_qnap_bridge('mkdir', [
        'path' => $parent,
        'name' => $name,
        'register_share' => ($parent === '/')
    ]);
    if (!empty($res['ok'])) {
        invalidate_dir_cache($parent);
    }
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'touch' && $method === 'POST') {
    $body = get_json_body();
    $rawParent = normalize_rel_path($body['path'] ?? '/');
    if ($rawParent === '/') {
        json_out(['ok' => false, 'error' => 'Selecione uma pasta compartilhada antes de criar um arquivo.'], 400);
    }
    $parent = assert_path_allowed($currentUser, $rawParent, 'write');
    $name = trim((string)($body['name'] ?? 'Novo Documento.txt'));
    $content = (string)($body['content'] ?? '');
    if (!$name || preg_match('/[\/\\\\:*?"<>|]/', $name)) {
        json_out(['ok' => false, 'error' => 'Nome de arquivo invalido.'], 400);
    }
    $res = call_qnap_bridge('touch', ['path' => $parent, 'name' => $name, 'content' => $content]);
    if (!empty($res['ok'])) invalidate_dir_cache($parent);
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'rename' && $method === 'POST') {
    $body = get_json_body();
    $path = assert_path_allowed($currentUser, $body['path'] ?? '', 'write');
    if ($path !== '/' && !is_parent_writable($currentUser, $path)) {
        json_out(['ok' => false, 'error' => 'Nao e permitido renomear a pasta raiz de um compartilhamento.'], 403);
    }
    $newName = trim((string)($body['new_name'] ?? ''));
    if ($path === '/' || !$newName || preg_match('/[\/\\\\:*?"<>|]/', $newName)) {
        json_out(['ok' => false, 'error' => 'Caminho ou novo nome invalido.'], 400);
    }
    $res = call_qnap_bridge('rename', ['path' => $path, 'new_name' => $newName]);
    if (!empty($res['ok'])) {
        invalidate_inline_cache($path);
        invalidate_dir_cache(normalize_rel_path(dirname($path)));
    }
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if (($route === 'copy' || $route === 'move') && $method === 'POST') {
    $body = get_json_body();
    $sources = $body['sources'] ?? [];
    $dest = assert_path_allowed($currentUser, $body['dest'] ?? '/', 'write');
    if (!is_array($sources) || count($sources) === 0 || $dest === '/') {
        json_out(['ok' => false, 'error' => 'Selecione itens e uma pasta de destino valida.'], 400);
    }
    $cleanSources = [];
    foreach ($sources as $s) {
        if ($route === 'move') {
            $normS = assert_path_allowed($currentUser, $s, 'delete');
            if ($normS !== '/' && !is_parent_writable($currentUser, $normS)) {
                json_out(['ok' => false, 'error' => "Nao e permitido mover a pasta raiz '$normS'."], 403);
            }
        } else {
            $normS = assert_path_allowed($currentUser, $s, 'read');
        }
        if ($normS !== '/' && user_has_denied_descendant($currentUser, $normS)) {
            json_out(['ok' => false, 'error' => "A pasta '$normS' contem subpastas com acesso restrito."], 403);
        }
        if ($normS !== '/') $cleanSources[] = $normS;
    }
    if (empty($cleanSources)) {
        json_out(['ok' => false, 'error' => 'Nenhuma origem valida informada.'], 400);
    }
    $res = call_qnap_bridge($route, [
        'sources' => $cleanSources,
        'dest' => $dest,
        'deny_paths' => get_user_denied_descendants($currentUser, '/')
    ], 45);
    if (!empty($res['ok'])) {
        invalidate_dir_cache($dest);
        if ($route === 'move') {
            foreach ($cleanSources as $cs) {
                invalidate_inline_cache($cs);
                invalidate_dir_cache(normalize_rel_path(dirname($cs)));
            }
        }
    }
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'delete' && $method === 'POST') {
    $body = get_json_body();
    $paths = $body['paths'] ?? [];
    if (!is_array($paths) || count($paths) === 0) {
        json_out(['ok' => false, 'error' => 'Nenhum item selecionado para excluir.'], 400);
    }
    $cleanPaths = [];
    foreach ($paths as $p) {
        $normP = assert_path_allowed($currentUser, $p, 'delete');
        if ($normP === '/') continue;
        if (!is_parent_writable($currentUser, $normP)) {
            json_out(['ok' => false, 'error' => 'Nao e permitido excluir a pasta principal do subdiretorio compartilhado.'], 403);
        }
        $cleanPaths[] = $normP;
    }
    $res = call_qnap_bridge('delete', ['paths' => $cleanPaths], 35);
    if (!empty($res['ok'])) {
        foreach ($cleanPaths as $cp) {
            invalidate_inline_cache($cp);
            invalidate_dir_cache(normalize_rel_path(dirname($cp)));
        }
    }
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'upload' && $method === 'POST') {
    $rawTarget = normalize_rel_path($_POST['path'] ?? '/');
    if ($rawTarget === '/') {
        json_out(['ok' => false, 'error' => 'Abra uma pasta compartilhada antes de enviar arquivos.'], 400);
    }
    $targetPath = assert_path_allowed($currentUser, $rawTarget, 'write');
    if (empty($_FILES['files']) && empty($_FILES['file'])) {
        json_out(['ok' => false, 'error' => 'Nenhum arquivo recebido.'], 400);
    }

    $uploaded = [];
    $filesList = [];
    if (!empty($_FILES['file'])) {
        $filesList[] = $_FILES['file'];
    } else {
        $f = $_FILES['files'];
        if (is_array($f['name'])) {
            for ($i = 0; $i < count($f['name']); $i++) {
                $filesList[] = [
                    'name' => $f['name'][$i],
                    'tmp_name' => $f['tmp_name'][$i],
                    'error' => $f['error'][$i],
                    'size' => $f['size'][$i]
                ];
            }
        } else {
            $filesList[] = $f;
        }
    }

    $errors = [];
    foreach ($filesList as $item) {
        if ($item['error'] !== UPLOAD_ERR_OK) {
            $errors[] = $item['name'] . ' (erro de upload ' . $item['error'] . ')';
            continue;
        }
        $origName = basename(str_replace('\\', '/', $item['name']));
        $upId = 'up_' . bin2hex(random_bytes(8));
        $destTmp = UPLOAD_DIR . '/' . $upId . '_' . preg_replace('/[^a-zA-Z0-9._\-]/', '_', $origName);
        if (!move_uploaded_file($item['tmp_name'], $destTmp)) {
            $errors[] = $origName . ' (falha ao mover arquivo temporario)';
            continue;
        }
        $res = call_qnap_bridge('upload_pull', [
            'up_id' => $upId,
            'filename' => $origName,
            'target_path' => $targetPath
        ], 50);
        if (!empty($res['ok'])) {
            $uploaded[] = $origName;
            invalidate_inline_cache(rtrim($targetPath, '/') . '/' . $origName);
        } else {
            @unlink($destTmp);
            $errors[] = $origName . ': ' . ($res['error'] ?? 'falha na transferencia ao QNAP');
        }
    }
    if (count($uploaded) > 0) {
        invalidate_dir_cache($targetPath);
    }
    json_out([
        'ok' => count($uploaded) > 0 && count($errors) === 0,
        'uploaded' => $uploaded,
        'errors' => $errors
    ], (count($uploaded) > 0 ? 200 : 400));
}

if ($route === 'download') {
    $path = assert_path_allowed($currentUser, $_GET['path'] ?? '', 'read');
    if ($path === '/' || !$path) {
        json_out(['ok' => false, 'error' => 'Caminho invalido para download.'], 400);
    }
    if (user_has_denied_descendant($currentUser, $path)) {
        json_out(['ok' => false, 'error' => "A pasta '$path' contem subpastas com acesso restrito."], 403);
    }
    $inline = !empty($_GET['inline']);
    $forceRefresh = !empty($_GET['refresh']);
    $fetched = fetch_qnap_file($path, $inline, $forceRefresh);
    if (empty($fetched['ok'])) {
        http_response_code(404);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'error' => $fetched['error'] ?? 'Arquivo nao encontrado.']);
        exit;
    }
    serve_file_with_range(
        $fetched['file'],
        $fetched['mime'],
        $fetched['filename'],
        $inline,
        !empty($fetched['cleanup'])
    );
}

if ($route === 'preview') {
    $path = assert_path_allowed($currentUser, $_GET['path'] ?? '', 'read');
    if ($path === '/') json_out(['ok' => false, 'error' => 'Caminho invalido.'], 400);
    $res = call_qnap_bridge('read_text', ['path' => $path], 20);
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'save_text' && $method === 'POST') {
    $body = get_json_body();
    $path = assert_path_allowed($currentUser, $body['path'] ?? '', 'write');
    $content = (string)($body['content'] ?? '');
    if ($path === '/') json_out(['ok' => false, 'error' => 'Caminho invalido.'], 400);
    $res = call_qnap_bridge('write_text', ['path' => $path, 'content' => $content], 25);
    if (!empty($res['ok'])) invalidate_inline_cache($path);
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

if ($route === 'search') {
    $path = assert_path_allowed($currentUser, $_GET['path'] ?? '/', 'list');
    $q = trim((string)($_GET['q'] ?? ''));
    if (strlen($q) < 1) json_out(['ok' => true, 'items' => []]);
    $res = call_qnap_bridge('search', ['path' => $path, 'query' => $q], 25);
    if (!empty($res['ok']) && ($currentUser['role'] ?? '') !== 'admin' && !is_master_admin_user($currentUser)) {
        $res['items'] = array_values(array_filter($res['items'] ?? [], function($it) use ($currentUser) {
            return in_array(get_direct_path_mode($currentUser, $it['path'] ?? ''), ['rw', 'ro'], true);
        }));
    }
    json_out($res, !empty($res['ok']) ? 200 : 502);
}

if ($route === 'properties') {
    $path = assert_path_allowed($currentUser, $_GET['path'] ?? '/', 'read');
    $isAdmin = (($currentUser['role'] ?? '') === 'admin') || is_master_admin_user($currentUser);
    if (!$isAdmin && $path === '/') {
        json_out(['ok' => false, 'error' => 'Acesso restrito as propriedades da raiz.'], 403);
    }
    if (user_has_denied_descendant($currentUser, $path)) {
        json_out(['ok' => false, 'error' => "A pasta '$path' contem subpastas com acesso restrito."], 403);
    }
    $res = call_qnap_bridge('properties', ['path' => $path], 25);
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

// ==================== GERENCIAMENTO DO QNAP (ADMIN) ====================
if ($route === 'qnap_status') {
    require_permission($currentUser, 'manage_qnap');
    $res = call_qnap_bridge('qnap_status', [], 18);
    if (!empty($res['ok'])) {
        $state = read_json_file(STATE_FILE, []);
        $state['qnap_status'] = $res['status'] ?? $res;
        write_json_file(STATE_FILE, $state);
        $res['bridge_online'] = true;
        json_out($res);
    }
    $state = read_json_file(STATE_FILE, []);
    if (!empty($state['qnap_status'])) {
        json_out([
            'ok' => true,
            'status' => $state['qnap_status'],
            'bridge_online' => is_bridge_online(),
            'cached' => true,
            'warning' => $res['error'] ?? null
        ]);
    }
    json_out($res, 502);
}

if ($route === 'shares') {
    if ($method === 'GET') {
        if (!user_has_permission($currentUser, 'read') && !is_path_allowed($currentUser, '/', 'list')) {
            json_out(['ok' => false, 'error' => 'Permissao insuficiente.'], 403);
        }
        $res = call_qnap_bridge('list_shares', [], 18);
        if (!empty($res['ok'])) {
            $shares = $res['shares'] ?? [];
            if (($currentUser['role'] ?? '') !== 'admin' && !is_master_admin_user($currentUser)) {
                $shares = array_values(array_filter($shares, fn($s) => is_path_allowed($currentUser, '/' . ($s['name'] ?? ''), 'list')));
            }
            json_out(['ok' => true, 'shares' => $shares]);
        }
        $state = read_json_file(STATE_FILE, []);
        if (!empty($state['shares'])) {
            $shares = $state['shares'];
            if (($currentUser['role'] ?? '') !== 'admin' && !is_master_admin_user($currentUser)) {
                $shares = array_values(array_filter($shares, fn($s) => is_path_allowed($currentUser, '/' . ($s['name'] ?? ''), 'list')));
            }
            json_out(['ok' => true, 'shares' => $shares, 'cached' => true]);
        }
        json_out($res, 502);
    }
    if ($method === 'POST') {
        $body = get_json_body();
        if (($body['op'] ?? '') === 'set_access') {
            if (!user_has_permission($currentUser, 'manage_shares') && !user_has_permission($currentUser, 'manage_users')) {
                json_out(['ok' => false, 'error' => 'Permissao insuficiente para controlar acesso as pastas.'], 403);
            }
            $name = trim((string)($body['name'] ?? ''));
            if (!$name) {
                json_out(['ok' => false, 'error' => 'Informe o nome da pasta compartilhada.'], 400);
            }

            $qnapAccess = is_array($body['qnap_access'] ?? null) ? $body['qnap_access'] : [];
            $users = init_users_if_empty();
            $hasUnified = isset($body['user_access']) && is_array($body['user_access']);
            $allShareNames = is_array($body['all_shares'] ?? null) ? $body['all_shares'] : [];

            if ($hasUnified) {
                foreach ($users as &$u) {
                    if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) continue;
                    $uid = $u['id'];
                    if (!array_key_exists($uid, $body['user_access'])) continue;
                    $mode = strtolower(trim((string)$body['user_access'][$uid]));
                    if (!in_array($mode, ['rw', 'ro', 'none'], true)) $mode = 'none';

                    $curShares = is_array($u['allowed_shares'] ?? null) ? $u['allowed_shares'] : [];
                    if (in_array('*', $curShares, true)) {
                        if ($mode === 'none') {
                            $curShares = array_values(array_filter($allShareNames, fn($sn) => $sn !== $name));
                        }
                    } else {
                        $curShares = array_values(array_filter($curShares, fn($sn) => $sn !== $name));
                        if ($mode === 'rw' || $mode === 'ro') {
                            $curShares[] = $name;
                        }
                    }
                    $u['allowed_shares'] = array_values(array_unique($curShares));

                    $pa = normalize_user_path_access($u['path_access'] ?? []);
                    if ($mode === 'rw' || $mode === 'ro') {
                        $pa['/' . $name] = $mode;
                    } else {
                        unset($pa['/' . $name]);
                    }
                    $u['path_access'] = $pa;
                    $u['updated_at'] = date('c');

                    if (!empty($u['nas_username'])) {
                        $qnapAccess[$u['nas_username']] = $mode;
                    }
                }
                unset($u);
            }

            $qnapRes = call_qnap_bridge('set_share_access', [
                'name' => $name,
                'comment' => $body['comment'] ?? null,
                'qnap_access' => $qnapAccess,
                'everyone_access' => $body['everyone_access'] ?? null
            ], 25);

            if (!empty($qnapRes['ok'])) {
                if ($hasUnified) {
                    write_json_file(USERS_FILE, $users);
                } elseif (isset($body['portal_users']) && is_array($body['portal_users'])) {
                    foreach ($users as &$u) {
                        if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) continue;
                        $uid = $u['id'];
                        if (!array_key_exists($uid, $body['portal_users'])) continue;
                        $allow = (bool)$body['portal_users'][$uid];
                        $curShares = $u['allowed_shares'] ?? [];
                        if (in_array('*', $curShares, true)) {
                            if ($allow) continue;
                            $curShares = array_values(array_filter($allShareNames, fn($sn) => $sn !== $name));
                        } else {
                            $curShares = array_values(array_filter($curShares, fn($sn) => $sn !== $name));
                            if ($allow) $curShares[] = $name;
                        }
                        $u['allowed_shares'] = array_values(array_unique($curShares));
                        $u['updated_at'] = date('c');
                    }
                    unset($u);
                    write_json_file(USERS_FILE, $users);
                }
            }
            json_out($qnapRes, !empty($qnapRes['ok']) ? 200 : 400);
        }

        require_permission($currentUser, 'manage_shares');
        $name = trim((string)($body['name'] ?? ''));
        $comment = trim((string)($body['comment'] ?? 'Pasta criada pelo ServLynx'));
        if (!$name || !preg_match('/^[a-zA-Z0-9_\-\s]{2,40}$/', $name)) {
            json_out(['ok' => false, 'error' => 'Use apenas letras, numeros, espacos, - ou _ (2 a 40 caracteres).'], 400);
        }
        $res = call_qnap_bridge('create_share', ['name' => $name, 'comment' => $comment], 25);
        json_out($res, !empty($res['ok']) ? 200 : 400);
    }
    if ($method === 'DELETE') {
        require_permission($currentUser, 'manage_shares');
        $body = get_json_body();
        $name = trim((string)($body['name'] ?? ($_GET['name'] ?? '')));
        $deleteData = !empty($body['delete_data']);
        if (!$name) json_out(['ok' => false, 'error' => 'Informe o nome do compartilhamento.'], 400);
        $res = call_qnap_bridge('delete_share', ['name' => $name, 'delete_data' => $deleteData], 25);
        json_out($res, !empty($res['ok']) ? 200 : 400);
    }
}

function ensure_qnap_subdir_exists(string $normPath): array {
    $norm = normalize_rel_path($normPath);
    $segs = array_values(array_filter(explode('/', ltrim($norm, '/')), fn($s) => $s !== ''));
    if (count($segs) < 2) {
        return ['ok' => false, 'error' => 'Informe um subdiretorio dentro de uma pasta compartilhada.'];
    }
    $curr = '/' . $segs[0];
    for ($i = 1; $i < count($segs); $i++) {
        $seg = $segs[$i];
        if (preg_match('/[\/\\\\:*?"<>|]/', $seg)) {
            return ['ok' => false, 'error' => 'Nome de subdiretorio invalido: ' . $seg];
        }
        $res = call_qnap_bridge('mkdir', [
            'path' => $curr,
            'name' => $seg,
            'register_share' => false
        ], 18);
        if (empty($res['ok'])) {
            $err = (string)($res['error'] ?? '');
            if (stripos($err, 'existe') === false) {
                return ['ok' => false, 'error' => $err ?: ('Falha ao criar subdiretorio: ' . $curr . '/' . $seg)];
            }
        }
        invalidate_dir_cache($curr);
        $curr .= '/' . $seg;
    }
    invalidate_dir_cache($curr);
    return ['ok' => true, 'path' => $norm];
}

if ($route === 'subdir_access') {
    if (!user_has_permission($currentUser, 'manage_shares') && !user_has_permission($currentUser, 'manage_users')) {
        json_out(['ok' => false, 'error' => 'Permissao insuficiente.'], 403);
    }
    $users = init_users_if_empty();

    if ($method === 'GET') {
        $subdirsMap = [];
        foreach ($users as $u) {
            if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) continue;
            $pa = normalize_user_path_access($u['path_access'] ?? []);
            foreach ($pa as $p => $mode) {
                if (!isset($subdirsMap[$p])) {
                    $segs = array_values(array_filter(explode('/', ltrim($p, '/')), fn($s) => $s !== ''));
                    $subdirsMap[$p] = [
                        'path' => $p,
                        'name' => basename($p),
                        'parent_share' => $segs[0] ?? '',
                        'users' => []
                    ];
                }
                $subdirsMap[$p]['users'][] = [
                    'id' => $u['id'],
                    'name' => $u['name'] ?? '',
                    'email' => $u['email'] ?? '',
                    'nas_username' => $u['nas_username'] ?? '',
                    'mode' => $mode
                ];
            }
        }
        ksort($subdirsMap);

        $qPath = null;
        $matrix = null;
        if (!empty($_GET['path'])) {
            $qPath = normalize_rel_path($_GET['path']);
            $matrix = [];
            foreach ($users as $u) {
                $isAdm = (($u['role'] ?? '') === 'admin' || is_master_admin_user($u));
                $pa = normalize_user_path_access($u['path_access'] ?? []);
                $matrix[] = [
                    'id' => $u['id'],
                    'name' => $u['name'] ?? '',
                    'email' => $u['email'] ?? '',
                    'role' => $u['role'] ?? 'user',
                    'nas_username' => $u['nas_username'] ?? '',
                    'is_admin' => $isAdm,
                    'explicit_mode' => $isAdm ? 'rw' : ($pa[$qPath] ?? 'inherit'),
                    'inherited_mode' => get_inherited_path_mode($u, $qPath),
                    'effective_mode' => get_effective_path_mode($u, $qPath)
                ];
            }
        }

        json_out([
            'ok' => true,
            'subdirs' => array_values($subdirsMap),
            'path' => $qPath,
            'users_matrix' => $matrix
        ]);
    }

    if ($method === 'POST') {
        $body = get_json_body();
        $normPath = normalize_rel_path($body['path'] ?? '');
        $segs = array_values(array_filter(explode('/', ltrim($normPath, '/')), fn($s) => $s !== ''));
        if (count($segs) < 2) {
            json_out(['ok' => false, 'error' => 'Selecione ou informe um subdiretorio dentro de uma pasta raiz (ex: /Public/Projetos).'], 400);
        }
        if (!empty($body['create_if_missing'])) {
            $mk = ensure_qnap_subdir_exists($normPath);
            if (empty($mk['ok'])) {
                json_out(['ok' => false, 'error' => $mk['error'] ?? 'Falha ao criar subdiretorio no QNAP.'], 400);
            }
        }

        $portalAccess = is_array($body['portal_access'] ?? null) ? $body['portal_access'] : [];
        foreach ($users as &$u) {
            if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) continue;
            $uid = $u['id'] ?? '';
            if ($uid === '' || !array_key_exists($uid, $portalAccess)) continue;
            $m = strtolower(trim((string)$portalAccess[$uid]));
            $pa = normalize_user_path_access($u['path_access'] ?? []);
            if (in_array($m, ['rw', 'ro', 'none'], true)) {
                $pa[$normPath] = $m;
            } else {
                unset($pa[$normPath]);
            }
            $u['path_access'] = $pa;
            $u['updated_at'] = date('c');
        }
        unset($u);
        write_json_file(USERS_FILE, $users);

        json_out([
            'ok' => true,
            'path' => $normPath,
            'users' => array_map('sanitize_user_public', $users)
        ]);
    }

    if ($method === 'DELETE') {
        $body = get_json_body();
        $normPath = normalize_rel_path($body['path'] ?? ($_GET['path'] ?? ''));
        if ($normPath !== '/') {
            foreach ($users as &$u) {
                $pa = normalize_user_path_access($u['path_access'] ?? []);
                if (isset($pa[$normPath])) {
                    unset($pa[$normPath]);
                    $u['path_access'] = $pa;
                    $u['updated_at'] = date('c');
                }
            }
            unset($u);
            write_json_file(USERS_FILE, $users);
        }
        json_out(['ok' => true, 'path' => $normPath]);
    }
}

if ($route === 'qnap_action' && $method === 'POST') {
    require_permission($currentUser, 'manage_qnap');
    $body = get_json_body();
    $actionName = (string)($body['action'] ?? '');
    $res = call_qnap_bridge('qnap_action', ['action' => $actionName, 'params' => $body['params'] ?? []], 25);
    json_out($res, !empty($res['ok']) ? 200 : 400);
}

// ==================== GERENCIAMENTO DE USUARIOS ====================
function derive_qnap_username(string $explicitNas, string $email, string $name, bool $isMaster = false): string {
    $raw = trim($explicitNas);
    if ($raw === '') {
        if ($isMaster) {
            return 'Lynx';
        }
        $raw = str_contains($email, '@') ? explode('@', $email)[0] : ($email !== '' ? $email : $name);
    }
    if (function_exists('iconv')) {
        $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $raw);
        if ($ascii !== false) $raw = $ascii;
    }
    $raw = preg_replace('/[.\-\s]+/', '_', $raw);
    $clean = preg_replace('/[^a-zA-Z0-9_]/', '', $raw);
    $clean = trim($clean, '_');
    if ($clean !== '' && ctype_digit($clean[0])) {
        $clean = 'u_' . $clean;
    }
    $clean = substr($clean, 0, 28);
    if (in_array(strtolower($clean), ['admin', 'root', 'guest', 'httpdusr'], true)) {
        $clean = 'usr_' . strtolower($clean);
    }
    return $clean;
}

function build_auto_qnap_share_access(array $userRecord): array {
    $sharesRes = call_qnap_bridge('list_shares', [], 12);
    $sharesList = !empty($sharesRes['ok']) ? ($sharesRes['shares'] ?? []) : (read_json_file(STATE_FILE, [])['shares'] ?? []);
    if (!is_array($sharesList) || count($sharesList) === 0) {
        return [];
    }
    $isAdmin = (($userRecord['role'] ?? 'user') === 'admin');
    $allowedShares = is_array($userRecord['allowed_shares'] ?? null) ? $userRecord['allowed_shares'] : [];
    $allAllowed = $isAdmin || in_array('*', $allowedShares, true);
    $pa = normalize_user_path_access($userRecord['path_access'] ?? []);
    $perms = is_array($userRecord['permissions'] ?? null) ? $userRecord['permissions'] : [];
    $canWrite = $isAdmin || !empty($perms['write']);
    $canRead = $isAdmin || !empty($perms['read']) || $canWrite;

    $map = [];
    foreach ($sharesList as $sh) {
        $shName = trim((string)($sh['name'] ?? ''));
        if ($shName === '') continue;
        if (isset($pa['/' . $shName])) {
            $map[$shName] = $pa['/' . $shName];
        } elseif ($allAllowed || in_array($shName, $allowedShares, true)) {
            $map[$shName] = $canWrite ? 'rw' : ($canRead ? 'ro' : 'none');
        } else {
            $map[$shName] = 'none';
        }
    }
    return $map;
}

if ($route === 'users') {
    require_permission($currentUser, 'manage_users');
    $users = init_users_if_empty();

    if ($method === 'GET') {
        $list = array_map(fn($u) => sanitize_user_public($u, true), $users);
        $qnapUsersRes = call_qnap_bridge('list_qnap_users', [], 14);
        $sharesRes = call_qnap_bridge('list_shares', [], 14);
        $sharesList = !empty($sharesRes['ok']) ? ($sharesRes['shares'] ?? []) : (read_json_file(STATE_FILE, [])['shares'] ?? []);
        json_out([
            'ok' => true,
            'users' => $list,
            'qnap_users' => !empty($qnapUsersRes['ok']) ? ($qnapUsersRes['users'] ?? []) : [],
            'shares' => $sharesList
        ]);
    }

    if ($method === 'POST') {
        $body = get_json_body();
        $name = trim((string)($body['name'] ?? ''));
        $email = trim((string)($body['email'] ?? ($body['username'] ?? '')));
        $password = (string)($body['password'] ?? '');
        $phone = trim((string)($body['phone'] ?? ''));
        $notifyEmail = trim((string)($body['notify_email'] ?? ''));
        $role = (($body['role'] ?? 'user') === 'admin') ? 'admin' : 'user';
        $allowedShares = (isset($body['allowed_shares']) && is_array($body['allowed_shares'])) ? $body['allowed_shares'] : [];
        $perms = $body['permissions'] ?? [
            'read' => true,
            'write' => true,
            'delete' => ($role === 'admin'),
            'manage_users' => ($role === 'admin'),
            'manage_shares' => ($role === 'admin'),
            'manage_qnap' => ($role === 'admin')
        ];
        if ($role === 'admin') {
            $allowedShares = ['*'];
            $perms = full_admin_permissions();
        }
        if (!$name || !$email || strlen($password) < 8) {
            json_out(['ok' => false, 'error' => 'Preencha nome, usuario/e-mail e senha (min. 8 caracteres).'], 400);
        }
        foreach ($users as $u) {
            if (strcasecmp($u['email'] ?? '', $email) === 0 || strcasecmp($u['username'] ?? '', $email) === 0) {
                json_out(['ok' => false, 'error' => 'Ja existe um usuario com este e-mail/login.'], 409);
            }
        }
        $syncToQnap = array_key_exists('sync_to_qnap', $body) ? (bool)$body['sync_to_qnap'] : true;
        $nasUsername = derive_qnap_username((string)($body['nas_username'] ?? ''), $email, $name, false);

        $newUser = [
            'id' => 'usr_' . bin2hex(random_bytes(6)),
            'name' => $name,
            'email' => $email,
            'username' => $email,
            'phone' => $phone,
            'notify_email' => $notifyEmail,
            'password_hash' => hash_password_portable($password),
            'password_enc' => encrypt_password_reversible($password),
            'role' => $role,
            'active' => true,
            'allowed_shares' => is_array($allowedShares) ? $allowedShares : ['*'],
            'path_access' => ($role === 'admin') ? [] : normalize_user_path_access($body['path_access'] ?? []),
            'permissions' => $perms,
            'nas_username' => $nasUsername,
            'dav_key' => 'slxdav_' . bin2hex(random_bytes(12)),
            'created_at' => date('c')
        ];

        $qnapSyncResult = null;
        $qnapAccessResult = null;
        if ($syncToQnap && $nasUsername !== '') {
            $qnapSyncResult = call_qnap_bridge('create_qnap_user', [
                'username' => $nasUsername,
                'password' => $password,
                'is_admin' => ($role === 'admin')
            ], 20);

            $shareAccessMap = (is_array($body['qnap_share_access'] ?? null) && count($body['qnap_share_access']) > 0)
                ? $body['qnap_share_access']
                : build_auto_qnap_share_access($newUser);
            if (!empty($qnapSyncResult['ok']) && count($shareAccessMap) > 0) {
                $qnapAccessResult = call_qnap_bridge('set_qnap_user_access', [
                    'username' => $nasUsername,
                    'share_access' => $shareAccessMap,
                    'is_admin' => ($role === 'admin')
                ], 25);
            }
        }

        $users[] = $newUser;
        write_json_file(USERS_FILE, $users);

        $notifyResult = null;
        if (!empty($body['send_email']) || !empty($body['send_whatsapp'])) {
            $msgs = build_user_credentials_messages($newUser, $password, (string)($body['custom_note'] ?? ''));
            $notifyResult = [];
            if (!empty($body['send_email'])) {
                $eTo = get_user_contact_email($newUser);
                $notifyResult['email'] = $eTo !== ''
                    ? send_servlynx_email($eTo, $msgs['subject'], $msgs['html'])
                    : ['ok' => false, 'error' => 'E-mail de contato nao informado.'];
            }
            if (!empty($body['send_whatsapp'])) {
                $notifyResult['whatsapp'] = !empty($newUser['phone'])
                    ? send_servlynx_whatsapp($newUser['phone'], $msgs['whatsapp'])
                    : ['ok' => false, 'error' => 'WhatsApp nao informado.'];
            }
        }

        json_out([
            'ok' => true,
            'user' => sanitize_user_public($newUser, true),
            'qnap_sync' => $qnapSyncResult,
            'qnap_access_sync' => $qnapAccessResult,
            'notify_result' => $notifyResult
        ]);
    }

    if ($method === 'PUT') {
        $body = get_json_body();
        $id = (string)($body['id'] ?? '');
        if (!$id) json_out(['ok' => false, 'error' => 'ID do usuario obrigatorio.'], 400);
        $updated = null;
        if (!empty($body['password']) && strlen((string)$body['password']) < 8) {
            json_out(['ok' => false, 'error' => 'A nova senha deve ter no minimo 8 caracteres.'], 400);
        }
        $passwordChanged = false;
        $deactivated = false;
        foreach ($users as &$u) {
            if ($u['id'] === $id) {
                $isMaster = is_master_admin_user($u);
                if (isset($body['name']) && trim($body['name']) !== '') $u['name'] = trim($body['name']);
                if (isset($body['email']) && trim($body['email']) !== '') {
                    $u['email'] = trim($body['email']);
                    $u['username'] = trim($body['email']);
                }
                if (array_key_exists('phone', $body)) {
                    $u['phone'] = trim((string)$body['phone']);
                }
                if (array_key_exists('notify_email', $body)) {
                    $u['notify_email'] = trim((string)$body['notify_email']);
                }
                if (!empty($body['password'])) {
                    $u['password_hash'] = hash_password_portable((string)$body['password']);
                    $u['password_enc'] = encrypt_password_reversible((string)$body['password']);
                    $passwordChanged = true;
                }
                if (isset($body['role'])) {
                    $u['role'] = ($isMaster || $body['role'] === 'admin') ? 'admin' : 'user';
                }
                if (isset($body['active'])) {
                    $newActive = $isMaster ? true : (bool)$body['active'];
                    if (!$newActive && !empty($u['active'])) {
                        $deactivated = true;
                    }
                    $u['active'] = $newActive;
                }
                if (isset($body['allowed_shares']) && is_array($body['allowed_shares'])) {
                    $u['allowed_shares'] = ($u['role'] === 'admin' || $isMaster) ? ['*'] : $body['allowed_shares'];
                }
                if (isset($body['path_access']) && is_array($body['path_access'])) {
                    $u['path_access'] = ($u['role'] === 'admin' || $isMaster) ? [] : normalize_user_path_access($body['path_access']);
                }
                if (isset($body['permissions']) && is_array($body['permissions'])) {
                    $u['permissions'] = ($u['role'] === 'admin' || $isMaster) ? full_admin_permissions() : $body['permissions'];
                }
                if ($u['role'] === 'admin' || $isMaster) {
                    $u['role'] = 'admin';
                    $u['active'] = true;
                    $u['allowed_shares'] = ['*'];
                    $u['path_access'] = [];
                    $u['permissions'] = full_admin_permissions();
                }
                $explicitNas = isset($body['nas_username']) ? (string)$body['nas_username'] : (string)($u['nas_username'] ?? '');
                $u['nas_username'] = derive_qnap_username($explicitNas, (string)($u['email'] ?? ''), (string)($u['name'] ?? ''), $isMaster);
                $u['updated_at'] = date('c');
                $updated = $u;
                break;
            }
        }
        unset($u);
        if (!$updated) json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 404);
        write_json_file(USERS_FILE, $users);
        if ($passwordChanged || $deactivated) {
            $keepTok = (!$deactivated && $id === ($currentUser['id'] ?? '')) ? ($auth['token'] ?? '') : '';
            revoke_user_sessions($id, $keepTok);
            ensure_user_dav_key($id, true);
        }

        $nasU = $updated['nas_username'] ?? '';
        $qnapSyncResult = null;
        $qnapAccessResult = null;
        $syncOnUpdate = array_key_exists('sync_to_qnap', $body) ? (bool)$body['sync_to_qnap'] : true;
        if ($syncOnUpdate && $nasU !== '') {
            $newPass = (string)($body['password'] ?? '');
            $qnapSyncResult = call_qnap_bridge('create_qnap_user', [
                'username' => $nasU,
                'password' => $newPass,
                'is_admin' => ($updated['role'] === 'admin'),
                'ensure_only' => ($newPass === '')
            ], 20);

            $shareAccessMap = (is_array($body['qnap_share_access'] ?? null) && count($body['qnap_share_access']) > 0)
                ? $body['qnap_share_access']
                : build_auto_qnap_share_access($updated);
            if (!empty($qnapSyncResult['ok']) && count($shareAccessMap) > 0) {
                $qnapAccessResult = call_qnap_bridge('set_qnap_user_access', [
                    'username' => $nasU,
                    'share_access' => $shareAccessMap,
                    'is_admin' => ($updated['role'] === 'admin')
                ], 25);
            }
        }
        json_out([
            'ok' => true,
            'user' => sanitize_user_public($updated, true),
            'qnap_sync' => $qnapSyncResult,
            'qnap_access_sync' => $qnapAccessResult
        ]);
    }

    if ($method === 'DELETE') {
        $body = get_json_body();
        $id = (string)($body['id'] ?? ($_GET['id'] ?? ''));
        if (!$id) json_out(['ok' => false, 'error' => 'ID do usuario obrigatorio.'], 400);
        if ($id === $currentUser['id']) {
            json_out(['ok' => false, 'error' => 'Voce nao pode excluir sua propria conta ativa.'], 400);
        }
        $filtered = [];
        $deletedUser = null;
        foreach ($users as $u) {
            if ($u['id'] === $id) {
                if (is_master_admin_user($u)) {
                    json_out(['ok' => false, 'error' => 'Nao e possivel excluir o administrador principal do sistema.'], 403);
                }
                $deletedUser = $u;
            } else {
                $filtered[] = $u;
            }
        }
        if (!$deletedUser) json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 404);
        write_json_file(USERS_FILE, $filtered);
        revoke_user_sessions($id);
        if (!empty($body['delete_qnap_user']) && !empty($deletedUser['nas_username'])) {
            call_qnap_bridge('delete_qnap_user', ['username' => $deletedUser['nas_username']], 15);
        }
        json_out(['ok' => true]);
    }
}

// Acoes extras no usuario nativo do QNAP (criar/remover/trocar senha/controlar acesso do QNAP diretamente)
if ($route === 'qnap_user' && $method === 'POST') {
    require_permission($currentUser, 'manage_users');
    $body = get_json_body();
    $op = $body['op'] ?? 'create';
    if ($op === 'create') {
        $uname = trim((string)($body['username'] ?? ''));
        $res = call_qnap_bridge('create_qnap_user', [
            'username' => $uname,
            'password' => (string)($body['password'] ?? ''),
            'is_admin' => !empty($body['is_admin'])
        ], 20);
        if (!empty($res['ok']) && is_array($body['share_access'] ?? null) && count($body['share_access']) > 0) {
            call_qnap_bridge('set_qnap_user_access', [
                'username' => $res['username'] ?? $uname,
                'share_access' => $body['share_access'],
                'is_admin' => !empty($body['is_admin'])
            ], 20);
        }
        json_out($res, !empty($res['ok']) ? 200 : 400);
    } elseif ($op === 'password') {
        $res = call_qnap_bridge('change_qnap_password', [
            'username' => trim((string)($body['username'] ?? '')),
            'password' => (string)($body['password'] ?? '')
        ], 20);
        json_out($res, !empty($res['ok']) ? 200 : 400);
    } elseif ($op === 'set_access') {
        $uname = trim((string)($body['username'] ?? ''));
        $shareAccess = is_array($body['share_access'] ?? null) ? $body['share_access'] : [];
        $res = call_qnap_bridge('set_qnap_user_access', [
            'username' => $uname,
            'share_access' => $shareAccess,
            'is_admin' => array_key_exists('is_admin', $body) ? (bool)$body['is_admin'] : null
        ], 25);
        if (!empty($res['ok']) && $uname !== '' && count($shareAccess) > 0) {
            $users = init_users_if_empty();
            $changed = false;
            foreach ($users as &$u) {
                if (($u['role'] ?? '') === 'admin' || is_master_admin_user($u)) continue;
                if (strcasecmp((string)($u['nas_username'] ?? ''), $uname) !== 0) continue;
                $curShares = is_array($u['allowed_shares'] ?? null) ? $u['allowed_shares'] : [];
                if (in_array('*', $curShares, true)) {
                    $curShares = array_keys($shareAccess);
                }
                $pa = normalize_user_path_access($u['path_access'] ?? []);
                foreach ($shareAccess as $shName => $rawMode) {
                    $m = strtolower(trim((string)$rawMode));
                    $curShares = array_values(array_filter($curShares, fn($sn) => $sn !== $shName));
                    if ($m === 'rw' || $m === 'ro') {
                        $curShares[] = $shName;
                        $pa['/' . $shName] = $m;
                    } else {
                        unset($pa['/' . $shName]);
                    }
                }
                $u['allowed_shares'] = array_values(array_unique($curShares));
                $u['path_access'] = $pa;
                $u['updated_at'] = date('c');
                $changed = true;
            }
            unset($u);
            if ($changed) {
                write_json_file(USERS_FILE, $users);
            }
        }
        json_out($res, !empty($res['ok']) ? 200 : 400);
    } elseif ($op === 'delete') {
        $res = call_qnap_bridge('delete_qnap_user', [
            'username' => trim((string)($body['username'] ?? ''))
        ], 20);
        json_out($res, !empty($res['ok']) ? 200 : 400);
    }
}

if ($route === 'send_user_credentials' && $method === 'POST') {
    require_permission($currentUser, 'manage_users');
    $body = get_json_body();
    $userId = trim((string)($body['user_id'] ?? ''));
    $sendEmail = !empty($body['send_email']);
    $sendWa = !empty($body['send_whatsapp']);
    $emailTo = trim((string)($body['email_to'] ?? ''));
    $waTo = trim((string)($body['whatsapp_to'] ?? ''));
    $passOverride = (string)($body['password_override'] ?? '');
    $customNote = (string)($body['custom_note'] ?? '');

    if (!$userId) {
        json_out(['ok' => false, 'error' => 'Usuario nao informado.'], 400);
    }
    if (!$sendEmail && !$sendWa) {
        json_out(['ok' => false, 'error' => 'Selecione ao menos um canal (E-mail ou WhatsApp).'], 400);
    }

    $users = init_users_if_empty();
    $targetUser = null;
    foreach ($users as &$u) {
        if ($u['id'] === $userId) {
            if ($waTo !== '') {
                $u['phone'] = $waTo;
            }
            if ($emailTo !== '' && filter_var($emailTo, FILTER_VALIDATE_EMAIL)) {
                $u['notify_email'] = $emailTo;
            }
            if ($passOverride !== '') {
                if (strlen($passOverride) < 4) {
                    json_out(['ok' => false, 'error' => 'A senha deve ter no minimo 4 caracteres.'], 400);
                }
                $u['password_hash'] = hash_password_portable($passOverride);
                $u['password_enc'] = encrypt_password_reversible($passOverride);
            }
            $u['updated_at'] = date('c');
            $targetUser = $u;
            break;
        }
    }
    unset($u);

    if (!$targetUser) {
        json_out(['ok' => false, 'error' => 'Usuario nao encontrado.'], 404);
    }

    $plainPass = $passOverride !== '' ? $passOverride : decrypt_password_reversible($targetUser['password_enc'] ?? '');
    if ($plainPass === '') {
        json_out([
            'ok' => false,
            'need_password' => true,
            'error' => 'Informe ou gere a senha do usuario no campo de senha para sincronizar e enviar os dados de acesso.'
        ], 400);
    }

    write_json_file(USERS_FILE, $users);

    if ($passOverride !== '' && !empty($targetUser['nas_username'])) {
        call_qnap_bridge('change_qnap_password', [
            'username' => $targetUser['nas_username'],
            'password' => $passOverride
        ], 15);
    }

    $msgs = build_user_credentials_messages($targetUser, $plainPass, $customNote);
    $emailRes = null;
    $waRes = null;
    if ($sendEmail) {
        $destEmail = $emailTo ?: get_user_contact_email($targetUser);
        $emailRes = send_servlynx_email($destEmail, $msgs['subject'], $msgs['html']);
    }
    if ($sendWa) {
        $destPhone = $waTo ?: ($targetUser['phone'] ?? '');
        $waRes = send_servlynx_whatsapp($destPhone, $msgs['whatsapp']);
    }

    $anyOk = ($sendEmail && !empty($emailRes['ok'])) || ($sendWa && !empty($waRes['ok']));
    if (!$anyOk) {
        $errs = [];
        if ($sendEmail) $errs[] = 'E-mail: ' . ($emailRes['error'] ?? 'falha');
        if ($sendWa) $errs[] = 'WhatsApp: ' . ($waRes['error'] ?? 'falha');
        json_out([
            'ok' => false,
            'error' => implode(' | ', $errs),
            'email_result' => $emailRes,
            'whatsapp_result' => $waRes
        ], 502);
    }

    json_out([
        'ok' => true,
        'email_result' => $emailRes,
        'whatsapp_result' => $waRes,
        'user' => sanitize_user_public($targetUser, true)
    ]);
}

if ($route === 'notify_config') {
    require_permission($currentUser, 'manage_users');
    if ($method === 'GET') {
        json_out(['ok' => true, 'config' => get_notify_config()]);
    }
    if ($method === 'POST') {
        $body = get_json_body();
        $op = (string)($body['op'] ?? 'save');
        $cur = get_notify_config();
        $allowedKeys = [
            'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'smtp_from_name',
            'evolution_url', 'evolution_instance', 'evolution_apikey', 'evolution_webhook', 'support_whatsapp'
        ];
        foreach ($allowedKeys as $k) {
            if (array_key_exists($k, $body)) {
                $cur[$k] = ($k === 'smtp_port') ? (int)$body[$k] : trim((string)$body[$k]);
            }
        }
        write_json_file(NOTIFY_CONFIG_FILE, $cur);

        if ($op === 'test_email') {
            $to = trim((string)($body['test_to'] ?? ($cur['smtp_user'] ?? '')));
            $res = send_servlynx_email(
                $to,
                'Teste SMTP ServLynx — Configuracao Validada',
                '<p>Ola! Este e um e-mail de teste enviado pelo <strong>ServLynx Explorer</strong> via <code>' . htmlspecialchars((string)$cur['smtp_host'], ENT_QUOTES, 'UTF-8') . '</code>.</p>'
            );
            json_out($res, !empty($res['ok']) ? 200 : 502);
        }
        if ($op === 'test_whatsapp') {
            $to = trim((string)($body['test_to'] ?? ($cur['support_whatsapp'] ?? '')));
            $res = send_servlynx_whatsapp(
                $to,
                "✅ *Teste ServLynx Explorer*\nConexao com a Evolution API (*{$cur['evolution_instance']}*) funcionando corretamente!"
            );
            json_out($res, !empty($res['ok']) ? 200 : 502);
        }
        if ($op === 'sync_webhook') {
            $evoUrl = rtrim((string)$cur['evolution_url'], '/');
            $inst = rawurlencode((string)$cur['evolution_instance']);
            $hookUrl = (string)$cur['evolution_webhook'];
            $payload = json_encode([
                'webhook' => [
                    'enabled' => true,
                    'url' => $hookUrl,
                    'webhookByEvents' => false,
                    'webhookBase64' => false,
                    'events' => ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']
                ]
            ], JSON_UNESCAPED_SLASHES);
            $ch = curl_init("{$evoUrl}/webhook/set/{$inst}");
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 20,
                CURLOPT_SSL_VERIFYPEER => false,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'apikey: ' . (string)$cur['evolution_apikey']
                ]
            ]);
            $resp = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            json_out([
                'ok' => ($code >= 200 && $code < 300),
                'http_code' => $code,
                'webhook_url' => $hookUrl,
                'response' => json_decode((string)$resp, true)
            ], ($code >= 200 && $code < 300) ? 200 : 502);
        }

        json_out(['ok' => true, 'config' => $cur]);
    }
}

json_out(['ok' => false, 'error' => 'Rota nao encontrada: ' . $route], 404);
