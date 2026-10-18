#!/usr/bin/env python3
"""Apply bounded backpressure before reading, or close after one body prefix."""

import json
import os
import socket
import sys
import time


BODY_BYTES = 9 * 1024**2
BATCH = 32


def main():
    ready, result, mode = sys.argv[1:]
    closed_marker = result + ".sender-closed"
    complete_frames = received = acks = 0
    partial = False
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 65536)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        with open(ready, "w", encoding="utf-8") as output:
            output.write("tcp://127.0.0.1:%d\n" % listener.getsockname()[1])
        with listener.accept()[0] as connection:
            connection.settimeout(10)
            stream = connection.makefile("rb")
            count = BATCH if mode == "timeout" else 1
            requests = [{"id": i, "method": "grid/rows", "params": {
                "view": "binary-view", "generation": 1, "max_bytes": BODY_BYTES,
            }} for i in range(count)]
            connection.sendall(b"".join(json.dumps(r).encode() + b"\n" for r in requests))
            if mode == "timeout":
                # R signals its own closed state. Until then this peer neither
                # reads nor closes, so EOF must originate at the sender.
                deadline = time.monotonic() + 12
                while not os.path.exists(closed_marker) and time.monotonic() < deadline:
                    time.sleep(0.005)
                assert os.path.exists(closed_marker), "sender did not time out under bounded backpressure"
            while True:
                line = stream.readline(65537)
                if not line:
                    break
                if not line.endswith(b"\n"):
                    assert mode == "timeout" and len(line) < 65537, line[:100]
                    partial = True
                    break
                header = json.loads(line)
                if header.get("method") == "ack":
                    acks += 1
                    continue
                assert "result" in header, (mode, header)
                declared = header["result"]["transfer"]["byte_length"]
                assert declared == BODY_BYTES, header
                remaining = declared if mode == "timeout" else 1024
                while remaining:
                    chunk = stream.read(min(65536, remaining))
                    if not chunk:
                        partial = True
                        break
                    assert chunk == b"x" * len(chunk), "non-body bytes were inserted"
                    received += len(chunk)
                    remaining -= len(chunk)
                if mode == "disconnect":
                    partial = True
                    break
                if partial:
                    break
                complete_frames += 1
            stream.close()
        if mode == "timeout":
            assert complete_frames < BATCH, complete_frames
        else:
            assert received == 1024, received
    temporary = result + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({"partial": partial, "received": received, "declared": BODY_BYTES,
                   "only_body": True, "complete_frames": complete_frames,
                   "requested_frames": count, "sender_closed": mode == "timeout",
                   "acks": acks}, output)
    os.replace(temporary, result)


if __name__ == "__main__":
    main()
