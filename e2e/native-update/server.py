import http.server, ssl, sys, os, threading
DATA = os.urandom(3 * 1024 * 1024)
state = {'mode': 'ok', 'n': 0, 'range': '-', 'reqs': 0}
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass
    def small(self, code, body=b'', headers=()):
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        p = self.path
        if p.startswith('/mode?'):
            state['mode'] = p.split('?', 1)[1]; state['n'] = 0; return self.small(200, b'ok')
        if p == '/lastrange': return self.small(200, state['range'].encode())
        if p == '/stats': return self.small(200, str(state['reqs']).encode())
        if p == '/apk': return self.small(302, headers=[('Location', '/real?sig=x')])
        if p.startswith('/real'):
            state['reqs'] += 1; state['n'] += 1
            m = state['mode']
            if m == 'gone': return self.small(404)
            rng = self.headers.get('Range'); state['range'] = rng or '-'
            start = 0
            if rng and m != 'noRange': start = int(rng.split('=')[1].split('-')[0])
            body = DATA[start:]
            if start > 0:
                self.send_response(206); self.send_header('Content-Range', f'bytes {start}-{len(DATA)-1}/{len(DATA)}')
            else: self.send_response(200)
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            drop = (m == 'drop1' and state['n'] == 1) or m == 'dropAll'
            cut = len(body) * 4 // 10 if drop else len(body)
            for i in range(0, cut, 65536): self.wfile.write(body[i:min(cut, i + 65536)])
            if drop:
                self.wfile.flush(); self.connection.shutdown(2); self.close_connection = True
            return
        self.small(404)
import hashlib
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain('cert.pem', 'key.pem')  # run.sh 在临时目录里生成
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
print(srv.server_address[1], hashlib.sha256(DATA).hexdigest(), len(DATA), flush=True)
srv.serve_forever()
