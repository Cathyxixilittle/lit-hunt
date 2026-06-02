#!/usr/bin/env python3
"""MiniMax API proxy server for lit-hunt.
Reads MINIMAX_API_KEY from environment and injects it into script.js on the fly.
Usage:
  export MINIMAX_API_KEY='your-key-here'
  python3 server.py
Then open http://localhost:5173
"""

import os
import http.server
import socketserver
import re

PORT = 5180
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
API_KEY = os.getenv("MINIMAX_API_KEY", "")
PLACEHOLDER = "MINIMAX_API_KEY_PLACEHOLDER"


class LitHuntHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)

        # Inject API key into script.js
        if path.endswith("script.js") and API_KEY:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            content = content.replace(f"'{PLACEHOLDER}'", f"'{API_KEY}'")
            content = content.replace(f'"{PLACEHOLDER}"', f'"{API_KEY}"')
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(content.encode("utf-8"))
            return

        return super().do_GET()

    def translate_path(self, path):
        import os
        filepath = super().translate_path(path)
        if filepath.endswith("/") or not os.path.isfile(filepath):
            return os.path.join(DIRECTORY, "index.html")
        return filepath


if __name__ == "__main__":
    print(f"Starting lit-hunt server at http://localhost:{PORT}")
    print(f"MiniMax API Key: {'✓ 已加载' if API_KEY else '✗ 未设置（请先 export MINIMAX_API_KEY）'}")
    print(f"Serving files from: {DIRECTORY}")
    with socketserver.TCPServer(("", PORT), LitHuntHandler) as httpd:
        print(f"Open http://localhost:{PORT}")
        httpd.serve_forever()
