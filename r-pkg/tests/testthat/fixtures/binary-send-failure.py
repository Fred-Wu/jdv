#!/usr/bin/env python3
"""Stop consuming a binary body, or disconnect after its first bytes."""

import json
import os
import socket
import sys
import time


def main():
    ready, result, mode = sys.argv[1:]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        with open(ready, "w", encoding="utf-8") as output:
            output.write("tcp://127.0.0.1:%d\n" % listener.getsockname()[1])
        with listener.accept()[0] as connection:
            connection.settimeout(10)
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
            stream = connection.makefile("rb")
            request = {"id": 1, "method": "table/rows", "params": {
                "view": "binary-view", "generation": 1, "max_bytes": 9 * 1024**2,
            }}
            connection.sendall(json.dumps(request).encode() + b"\n")
            header = json.loads(stream.readline())
            while header.get("method") == "ack":
                header = json.loads(stream.readline())
            assert "result" in header, (mode, header)
            declared = header["result"]["transfer"]["byte_length"]
            payload = stream.read(1024)
            if mode == "timeout":
                time.sleep(0.5)
                payload += stream.read()
            stream.close()
        assert declared == 9 * 1024**2, header
        assert 0 < len(payload) < declared, len(payload)
        assert payload == b"x" * len(payload), "non-body bytes were inserted"
    temporary = result + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({"partial": True, "received": len(payload), "declared": declared,
                   "only_body": True}, output)
    os.replace(temporary, result)


if __name__ == "__main__":
    main()
