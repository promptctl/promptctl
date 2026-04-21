#!/usr/bin/env python3
"""Mock promptctl deep-link HTTP endpoint for the dispatch-script test.

Starts on a random port, writes the port to ~/.promptctl/deep-link-port,
and logs every POST /open payload to /tmp/captured.jsonl. The test harness
then greps that file for the expected session id.
"""
import http.server
import json
import os
import sys
import threading

CAPTURE_PATH = "/tmp/captured.jsonl"


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        with open(CAPTURE_PATH, "ab") as f:
            f.write(body)
            f.write(b"\n")
        print(f"mock-server: POST {self.path} {body!r}", flush=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, fmt, *args):
        sys.stderr.write("mock-server: " + (fmt % args) + "\n")


def main():
    port_file = os.path.expanduser("~/.promptctl/deep-link-port")
    os.makedirs(os.path.dirname(port_file), exist_ok=True)
    open(CAPTURE_PATH, "wb").close()

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    with open(port_file, "w") as f:
        f.write(str(port))
    print(f"mock-server: listening on 127.0.0.1:{port}, port file {port_file}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
