"""Static server with cross-origin isolation, so SharedArrayBuffer exists.

Obsidian's app:// origin has SharedArrayBuffer without being cross-origin
isolated; a plain http:// page does not, so the headers are set here to put
the harness in the same position as the plugin rather than a weaker one.
"""

import functools
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = "/tmp/opencode/webtest"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(Handler, directory=ROOT)) as httpd:
    httpd.serve_forever()
