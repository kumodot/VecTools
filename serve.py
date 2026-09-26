"""
serve.py - tiny static server for VecTools with caching disabled.

python -m http.server sends no Cache-Control header, so browsers may keep an
old copy of a JS module across app updates (the entry page cache-busts only
main.js; the modules it imports are versioned with ?v= too, but a no-store
server makes local development bullet-proof).

Usage: python serve.py [port]   (default 8765, binds 127.0.0.1)
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.json': 'application/json', '.svg': 'image/svg+xml', '.exr': 'application/octet-stream',
                      '.hdr': 'application/octet-stream', '.vtools': 'application/json'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter console
        if '404' in str(args): super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'VecTools server on http://127.0.0.1:{port}/  (caching disabled, Ctrl+C to stop)')
    ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
