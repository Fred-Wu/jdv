#!/usr/bin/env python3
"""Unix-domain JSONL peer that records every message as it arrives.

The result file is rewritten after each message so a test can observe the
connection while it is still open. When the control file appears, the peer
sends a view/close request for the most recently opened view.
"""

import argparse
import json
import os
import select
import socket
import time


def write_result(path, value):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as result:
        json.dump(value, result)
        result.flush()
        os.fsync(result.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--ready", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--control", required=True)
    args = parser.parse_args()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(1)
    with open(args.ready, "w", encoding="utf-8"):
        pass
    messages = []
    buffer = bytearray()
    close_sent = False
    last_open = None
    deadline = time.monotonic() + 30
    with server:
        connection, _ = server.accept()
        with connection:
            while time.monotonic() < deadline:
                if not close_sent and os.path.exists(args.control) and last_open:
                    request = {
                        "id": "host-close-1",
                        "method": "view/close",
                        "params": {
                            "view": last_open["view"],
                            "generation": last_open["generation"],
                        },
                    }
                    connection.sendall(
                        json.dumps(request, separators=(",", ":")).encode("utf-8")
                        + b"\n"
                    )
                    close_sent = True
                if os.path.exists(args.control + ".close"):
                    return
                ready, _, _ = select.select([connection], [], [], 0.02)
                if not ready:
                    continue
                chunk = connection.recv(65536)
                if not chunk:
                    write_result(args.result + ".eof", len(messages))
                    return
                buffer.extend(chunk)
                changed = False
                while True:
                    newline = buffer.find(b"\n")
                    if newline < 0:
                        break
                    line = bytes(buffer[:newline])
                    del buffer[: newline + 1]
                    message = json.loads(line.decode("utf-8"))
                    if message.get("method") == "ack":
                        continue
                    if message.get("method") == "view/open":
                        last_open = message["params"]
                    messages.append(message)
                    changed = True
                if changed:
                    write_result(args.result, {"messages": messages})


if __name__ == "__main__":
    main()
