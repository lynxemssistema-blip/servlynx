<?php
/**
 * ServLynx Drive — Servidor WebDAV RFC 4918 para montar o QNAP como Disco Rigido (L:)
 * Endpoint: https://servlynx.lynxems.com.br/dav.php
 */

require_once __DIR__ . '/bridge_lib.php';

function dav_require_auth() {
    $user = $_SERVER['PHP_AUTH_USER'] ?? '';
    $pass = $_SERVER['PHP_AUTH_PW'] ?? '';

    if ($user === '' && $pass === '') {
        $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (preg_match('/Basic\s+(.+)/i', $hdr, $m)) {
            $decoded = base64_decode(trim($m[1]), true);
            if ($decoded !== false && strpos($decoded, ':') !== false) {
                list($user, $pass) = explode(':', $decoded, 2);
            }
        }
    }

    if ($user !== '') {
        $ip = get_client_ip();
        $rlKey = $ip . '|' . strtolower($user);
        $rl = check_rate_limit('dav_auth', $rlKey, 12, 900);
        $rlIp = check_rate_limit('dav_ip', $ip, 60, 900);
        if (!$rl['allowed'] || !$rlIp['allowed']) {
            $retry = max((int)($rl['retry_after'] ?? 0), (int)($rlIp['retry_after'] ?? 0));
            http_response_code(429);
            header('Retry-After: ' . max(1, $retry));
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Muitas tentativas WebDAV. Aguarde alguns minutos.';
            exit;
        }
        $res = find_authenticated_dav_user($user, $pass);
        if (!empty($res['user'])) {
            clear_rate_limit('dav_auth', $rlKey);
            return $res['user'];
        }
        if (($res['code'] ?? 401) === 401) {
            record_rate_limit_hit('dav_auth', $rlKey, 900);
            record_rate_limit_hit('dav_ip', $ip, 900);
        }
    }

    header('WWW-Authenticate: Basic realm="ServLynx Drive QNAP"');
    http_response_code(401);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Autenticacao ServLynx necessaria.';
    exit;
}

function dav_base_prefix() {
    static $prefix = null;
    if ($prefix !== null) return $prefix;
    $uri = $_SERVER['REQUEST_URI'] ?? '/dav.php/';
    $qPos = strpos($uri, '?');
    if ($qPos !== false) {
        $uri = substr($uri, 0, $qPos);
    }
    if ($uri === '/dav.php' || strpos($uri, '/dav.php') !== false) {
        $prefix = '/dav.php';
    } elseif ($uri === '/dav' || strpos($uri, '/dav/') === 0) {
        $prefix = '/dav';
    } else {
        $prefix = '/dav';
    }
    return $prefix;
}

function dav_strip_prefix($uriPath) {
    $posPhp = strpos($uriPath, '/dav.php');
    if ($posPhp !== false) {
        return substr($uriPath, $posPhp + 8);
    }
    if ($uriPath === '/dav' || strpos($uriPath, '/dav/') === 0) {
        return substr($uriPath, 4);
    }
    return null;
}

function dav_extract_path() {
    $uri = $_SERVER['REQUEST_URI'] ?? '/dav.php/';
    $qPos = strpos($uri, '?');
    if ($qPos !== false) {
        $uri = substr($uri, 0, $qPos);
    }
    $stripped = dav_strip_prefix($uri);
    $rel = ($stripped !== null) ? $stripped : ($_SERVER['PATH_INFO'] ?? '/');
    $rel = rawurldecode($rel);
    return normalize_rel_path($rel ?: '/');
}

function dav_extract_dest_path() {
    $destHdr = $_SERVER['HTTP_DESTINATION'] ?? '';
    if (!$destHdr) return '';
    $parsed = parse_url($destHdr);
    $uriPath = $parsed['path'] ?? $destHdr;
    $stripped = dav_strip_prefix($uriPath);
    $rel = ($stripped !== null) ? $stripped : $uriPath;
    return normalize_rel_path(rawurldecode($rel ?: '/'));
}

function dav_href($relPath, $isDir = false) {
    $prefix = dav_base_prefix();
    $norm = normalize_rel_path($relPath);
    if ($norm === '/') {
        return $prefix . '/';
    }
    $segs = explode('/', ltrim($norm, '/'));
    $enc = implode('/', array_map('rawurlencode', $segs));
    return $prefix . '/' . $enc . ($isDir ? '/' : '');
}

function dav_is_windows_probe($relPath) {
    $base = strtolower(basename(normalize_rel_path($relPath)));
    return in_array($base, ['desktop.ini', 'autorun.inf', 'thumbs.db', 'folder.jpg', 'folder.gif', '.ds_store'], true);
}

function dav_list_dir_raw($dirPath, $maxAge = 8) {
    $norm = normalize_rel_path($dirPath);
    $cacheFile = DATA_DIR . '/dir_cache_' . md5($norm) . '.json';
    if ($maxAge > 0 && file_exists($cacheFile) && (time() - @filemtime($cacheFile)) <= $maxAge) {
        $cached = read_json_file($cacheFile, null);
        if (is_array($cached) && isset($cached['items']) && ($cached['updated_at'] ?? 0) >= time() - $maxAge) {
            return ['ok' => true, 'items' => $cached['items']];
        }
    }
    $res = call_qnap_bridge('list_dir', ['path' => $norm, 'show_hidden' => false], 18);
    if (!empty($res['ok'])) {
        write_json_file($cacheFile, [
            'path' => $norm,
            'items' => $res['items'] ?? [],
            'updated_at' => time()
        ]);
    }
    return $res;
}

function dav_xml_escape($s) {
    return htmlspecialchars((string)$s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function dav_response_entry($relPath, $isDir, $size, $mtime, $name) {
    $href = dav_xml_escape(dav_href($relPath, $isDir));
    $ts = $mtime ? (int)$mtime : time();
    $httpDate = gmdate('D, d M Y H:i:s', $ts) . ' GMT';
    $isoDate = gmdate('Y-m-d\TH:i:s\Z', $ts);
    $etag = '"' . md5($relPath . ':' . $ts . ':' . $size) . '"';
    $display = dav_xml_escape($name === '' ? 'ServLynx Drive' : $name);

    static $diskQuota = null;
    if ($diskQuota === null) {
        $st = read_json_file(STATE_FILE, []);
        $diskQuota = is_array($st['qnap_status']['disk'] ?? null) ? $st['qnap_status']['disk'] : [];
    }

    $quotaXml = '';
    if ($isDir) {
        $typeXml = '<D:resourcetype><D:collection/></D:resourcetype>';
        $lenXml = '<D:getcontentlength>0</D:getcontentlength>';
        $mimeXml = '<D:getcontenttype>httpd/unix-directory</D:getcontenttype>';
        if (isset($diskQuota['avail'], $diskQuota['used'])) {
            $availBytes = max(0, (int)$diskQuota['avail']);
            $usedBytes = max(0, (int)$diskQuota['used']);
            $quotaXml = "\n        <D:quota-available-bytes>{$availBytes}</D:quota-available-bytes>\n        <D:quota-used-bytes>{$usedBytes}</D:quota-used-bytes>";
        }
    } else {
        $mime = detect_media_mime($name);
        $typeXml = '<D:resourcetype/>';
        $lenXml = '<D:getcontentlength>' . (int)$size . '</D:getcontentlength>';
        $mimeXml = '<D:getcontenttype>' . dav_xml_escape($mime) . '</D:getcontenttype>';
    }

    return "  <D:response>\n"
         . "    <D:href>{$href}</D:href>\n"
         . "    <D:propstat>\n"
         . "      <D:prop>\n"
         . "        <D:displayname>{$display}</D:displayname>\n"
         . "        {$typeXml}\n"
         . "        {$lenXml}\n"
         . "        {$mimeXml}\n"
         . "        <D:getlastmodified>{$httpDate}</D:getlastmodified>\n"
         . "        <D:creationdate>{$isoDate}</D:creationdate>\n"
         . "        <D:getetag>{$etag}</D:getetag>{$quotaXml}\n"
         . "      </D:prop>\n"
         . "      <D:status>HTTP/1.1 200 OK</D:status>\n"
         . "    </D:propstat>\n"
         . "  </D:response>\n";
}

function dav_find_entry($user, $relPath) {
    $norm = normalize_rel_path($relPath);
    if ($norm === '/') {
        return ['exists' => true, 'is_dir' => true, 'size' => 0, 'mtime' => time(), 'name' => 'ServLynx Drive'];
    }
    if (dav_is_windows_probe($norm)) {
        return ['exists' => false];
    }
    $parent = normalize_rel_path(dirname($norm));
    $targetName = basename($norm);
    $res = dav_list_dir_raw($parent, 8);
    if (empty($res['ok'])) {
        return ['exists' => false];
    }
    $items = filter_items_for_user($user, $parent, $res['items'] ?? []);
    foreach ($items as $it) {
        if (($it['name'] ?? '') === $targetName) {
            return [
                'exists' => true,
                'is_dir' => !empty($it['is_dir']),
                'size' => (int)($it['size'] ?? 0),
                'mtime' => (int)($it['mtime'] ?? time()),
                'name' => $targetName
            ];
        }
    }
    return ['exists' => false];
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

// Permite OPTIONS antes ou depois, mas Windows WebClient aceita 200 com headers DAV
if ($method === 'OPTIONS') {
    header('DAV: 1, 2');
    header('MS-Author-Via: DAV');
    header('Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    header('Public: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    http_response_code(200);
    exit;
}

$currentUser = dav_require_auth();
$davPath = dav_extract_path();

if (!is_path_allowed($currentUser, $davPath, 'list')) {
    http_response_code(403);
    exit('Acesso negado.');
}

if (in_array($method, ['PROPFIND', 'GET', 'HEAD'], true) && dav_is_windows_probe($davPath)) {
    http_response_code(404);
    exit('Not found');
}

if ($method === 'PROPFIND') {
    $depth = $_SERVER['HTTP_DEPTH'] ?? '1';
    $entry = dav_find_entry($currentUser, $davPath);
    if (!$entry['exists']) {
        http_response_code(404);
        exit('Not found');
    }

    $entriesXml = dav_response_entry($davPath, $entry['is_dir'], $entry['size'], $entry['mtime'], $entry['name']);

    if ($entry['is_dir'] && strtolower((string)$depth) !== '0') {
        $listRes = dav_list_dir_raw($davPath, 8);
        if (!empty($listRes['ok'])) {
            $children = filter_items_for_user($currentUser, $davPath, $listRes['items'] ?? []);
            foreach ($children as $ch) {
                $childPath = rtrim($davPath, '/') . '/' . ($ch['name'] ?? '');
                if ($davPath === '/') $childPath = '/' . ($ch['name'] ?? '');
                $entriesXml .= dav_response_entry(
                    $childPath,
                    !empty($ch['is_dir']),
                    (int)($ch['size'] ?? 0),
                    (int)($ch['mtime'] ?? time()),
                    $ch['name'] ?? ''
                );
            }
        }
    }

    http_response_code(207);
    header('Content-Type: application/xml; charset=utf-8');
    header('DAV: 1, 2');
    echo "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
       . "<D:multistatus xmlns:D=\"DAV:\">\n"
       . $entriesXml
       . "</D:multistatus>\n";
    exit;
}

if ($method === 'GET' || $method === 'HEAD') {
    if ($davPath === '/') {
        header('Content-Type: text/html; charset=utf-8');
        echo '<h3>ServLynx Drive WebDAV</h3><p>Conecte este endereco como unidade de rede ou WebDAV no Windows/Celular.</p>';
        exit;
    }
    $entry = dav_find_entry($currentUser, $davPath);
    if (!$entry['exists']) {
        http_response_code(404);
        exit('Not found');
    }
    if ($entry['is_dir']) {
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        echo '<h3>Pasta: ' . htmlspecialchars($davPath, ENT_QUOTES, 'UTF-8') . '</h3>';
        exit;
    }
    if (!is_path_allowed($currentUser, $davPath, 'read')) {
        http_response_code(403);
        exit('Acesso negado.');
    }
    $fetched = fetch_qnap_file($davPath, true, false);
    if (empty($fetched['ok'])) {
        http_response_code(404);
        exit('File error');
    }
    serve_file_with_range($fetched['file'], $fetched['mime'], $fetched['filename'], true, !empty($fetched['cleanup']));
}

if ($method === 'PUT') {
    if ($davPath === '/' || !is_path_allowed($currentUser, $davPath, 'write')) {
        http_response_code(403);
        exit('Sem permissao de escrita nesta pasta.');
    }
    $segs = explode('/', ltrim($davPath, '/'));
    if (count($segs) < 2) {
        http_response_code(403);
        exit('Crie uma pasta dentro de um compartilhamento.');
    }
    $parent = normalize_rel_path(dirname($davPath));
    $filename = basename($davPath);
    $upId = 'up_' . bin2hex(random_bytes(8));
    $destTmp = UPLOAD_DIR . '/' . $upId . '_' . preg_replace('/[^a-zA-Z0-9._\-]/', '_', $filename);

    $in = fopen('php://input', 'rb');
    $out = fopen($destTmp, 'wb');
    if (!$in || !$out) {
        http_response_code(500);
        exit;
    }
    stream_copy_to_stream($in, $out);
    fclose($in);
    fclose($out);

    $writtenSize = @filesize($destTmp);
    if ($writtenSize === 0) {
        @unlink($destTmp);
        $res = call_qnap_bridge('touch', [
            'path' => $parent,
            'name' => $filename,
            'content' => ''
        ], 25);
    } else {
        $res = call_qnap_bridge('upload_pull', [
            'up_id' => $upId,
            'filename' => $filename,
            'target_path' => $parent
        ], 55);
    }

    if (empty($res['ok'])) {
        if (file_exists($destTmp)) @unlink($destTmp);
        http_response_code(500);
        exit($res['error'] ?? 'Upload error');
    }
    invalidate_inline_cache($davPath);
    invalidate_dir_cache($parent);
    http_response_code(201);
    exit;
}

if ($method === 'MKCOL') {
    if ($davPath === '/') {
        http_response_code(403);
        exit;
    }
    $parent = normalize_rel_path(dirname($davPath));
    $name = basename($davPath);
    if ($parent === '/') {
        if (($currentUser['role'] ?? '') !== 'admin' && !is_master_admin_user($currentUser)) {
            http_response_code(403);
            exit;
        }
    } elseif (!is_path_allowed($currentUser, $parent, 'write')) {
        http_response_code(403);
        exit('Sem permissao de escrita nesta pasta.');
    }
    $res = call_qnap_bridge('mkdir', [
        'path' => $parent,
        'name' => $name,
        'register_share' => ($parent === '/')
    ], 25);
    if (!empty($res['ok'])) {
        invalidate_dir_cache($parent);
        invalidate_dir_cache($davPath);
        http_response_code(201);
    } else {
        http_response_code(405);
    }
    exit;
}

if ($method === 'DELETE') {
    if ($davPath === '/' || !is_path_allowed($currentUser, $davPath, 'delete') || !is_parent_writable($currentUser, $davPath)) {
        http_response_code(403);
        exit('Sem permissao para excluir este item.');
    }
    $res = call_qnap_bridge('delete', ['paths' => [$davPath]], 35);
    if (!empty($res['ok'])) {
        invalidate_inline_cache($davPath);
        invalidate_dir_cache(dirname($davPath));
        invalidate_dir_cache($davPath);
        http_response_code(204);
    } else {
        http_response_code(404);
    }
    exit;
}

if ($method === 'MOVE' || $method === 'COPY') {
    $destPath = dav_extract_dest_path();
    if (!$destPath || $davPath === '/' || $destPath === '/' || !is_path_allowed($currentUser, $destPath, 'write')) {
        http_response_code(403);
        exit;
    }
    if (user_has_denied_descendant($currentUser, $davPath)) {
        http_response_code(403);
        exit('Pasta contem subpastas com acesso restrito.');
    }
    if ($method === 'MOVE') {
        if (!is_path_allowed($currentUser, $davPath, 'delete') || !is_parent_writable($currentUser, $davPath)) {
            http_response_code(403);
            exit;
        }
    } else {
        if (!is_path_allowed($currentUser, $davPath, 'read')) {
            http_response_code(403);
            exit;
        }
    }
    $srcParent = normalize_rel_path(dirname($davPath));
    $dstParent = normalize_rel_path(dirname($destPath));
    $dstName = basename($destPath);
    $overwrite = strtoupper(trim((string)($_SERVER['HTTP_OVERWRITE'] ?? 'T'))) !== 'F';
    $destEntry = dav_find_entry($currentUser, $destPath);
    $destExists = !empty($destEntry['exists']);

    if ($destExists) {
        if (!$overwrite) {
            http_response_code(412);
            exit('Precondition Failed');
        }
        if ($davPath !== $destPath) {
            if (!is_path_allowed($currentUser, $destPath, 'delete') || !is_parent_writable($currentUser, $destPath)) {
                http_response_code(403);
                exit('Sem permissao para sobrescrever o destino.');
            }
            call_qnap_bridge('delete', ['paths' => [$destPath]], 25);
        }
    }

    if ($method === 'MOVE' && $srcParent === $dstParent) {
        $res = call_qnap_bridge('rename', ['path' => $davPath, 'new_name' => $dstName], 25);
        if (!empty($res['ok'])) {
            invalidate_inline_cache($davPath);
            invalidate_inline_cache($destPath);
            invalidate_dir_cache($srcParent);
            invalidate_dir_cache($davPath);
            invalidate_dir_cache($destPath);
            http_response_code($destExists ? 204 : 201);
        } else {
            http_response_code(400);
        }
        exit;
    }

    $action = ($method === 'MOVE') ? 'move' : 'copy';
    $res = call_qnap_bridge($action, [
        'sources' => [$davPath],
        'dest' => $dstParent,
        'deny_paths' => get_user_denied_descendants($currentUser, '/')
    ], 45);
    if (!empty($res['ok'])) {
        if ($method === 'MOVE') invalidate_inline_cache($davPath);
        invalidate_inline_cache($destPath);
        invalidate_dir_cache($srcParent);
        invalidate_dir_cache($dstParent);
        invalidate_dir_cache($davPath);
        // Caso tenha havido tambem mudanca de nome ao mover/copiar
        $srcBase = basename($davPath);
        if ($srcBase !== $dstName) {
            $movedPath = ($dstParent === '/' ? '' : $dstParent) . '/' . $srcBase;
            call_qnap_bridge('rename', ['path' => $movedPath, 'new_name' => $dstName], 20);
        }
        http_response_code($destExists ? 204 : 201);
    } else {
        http_response_code(400);
    }
    exit;
}

if ($method === 'LOCK') {
    $token = 'opaquelocktoken:' . bin2hex(random_bytes(16));
    $href = dav_xml_escape(dav_href($davPath, false));
    http_response_code(200);
    header('Content-Type: application/xml; charset=utf-8');
    header('Lock-Token: <' . $token . '>');
    echo "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
       . "<D:prop xmlns:D=\"DAV:\"><D:lockdiscovery><D:activelock>\n"
       . "  <D:locktype><D:write/></D:locktype>\n"
       . "  <D:lockscope><D:exclusive/></D:lockscope>\n"
       . "  <D:depth>0</D:depth>\n"
       . "  <D:owner><D:href>{$href}</D:href></D:owner>\n"
       . "  <D:timeout>Second-600</D:timeout>\n"
       . "  <D:locktoken><D:href>{$token}</D:href></D:locktoken>\n"
       . "</D:activelock></D:lockdiscovery></D:prop>\n";
    exit;
}

if ($method === 'UNLOCK') {
    http_response_code(204);
    exit;
}

if ($method === 'PROPPATCH') {
    $href = dav_xml_escape(dav_href($davPath, false));
    http_response_code(207);
    header('Content-Type: application/xml; charset=utf-8');
    echo "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
       . "<D:multistatus xmlns:D=\"DAV:\">\n"
       . "  <D:response><D:href>{$href}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n"
       . "</D:multistatus>\n";
    exit;
}

http_response_code(405);
header('Allow: OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
