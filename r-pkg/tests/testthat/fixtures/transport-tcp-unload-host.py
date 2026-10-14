#!/usr/bin/env python3
"""Accept one jdv TCP connection and record when its peer closes."""

import json
from pathlib import Path
import socket
import sys

ready_path = Path(sys.argv[1])
connected_path = Path(sys.argv[2])
eof_path = Path(sys.argv[3])

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    server.settimeout(10)
    host, port = server.getsockname()
    ready_path.write_text(f"tcp://{host}:{port}", encoding="utf-8")
    connection, _ = server.accept()
    with connection:
        connection.settimeout(10)
        stream = connection.makefile("rb")
        hello = json.loads(stream.readline().decode("utf-8"))
        opened = json.loads(stream.readline().decode("utf-8"))
        connected_path.write_text(
            json.dumps({"hello": hello, "open": opened}), encoding="utf-8"
        )
        while connection.recv(4096):
            pass
        eof_path.write_text("eof\n", encoding="utf-8")
