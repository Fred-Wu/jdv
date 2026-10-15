#!/usr/bin/env python3
"""Exercise private R binary responses over a local JSONL and raw-byte stream."""

import json
import os
import socket
import sys


def main():
    ready, result = sys.argv[1:]
    cases = [
        ("valid", None), ("empty", None),
        ("wrong_id", "invalid_request"), ("wrong_view", "invalid_request"),
        ("wrong_generation", "invalid_request"), ("wrong_length", "invalid_request"),
        ("wrong_encoding", "invalid_request"), ("wrong_marker", "invalid_request"),
        ("wrong_fields", "invalid_request"), ("wrong_payload", "invalid_request"),
        ("invalid_header", "invalid_request"), ("newline_header", "invalid_request"),
        ("scalar_transfer", "invalid_request"), ("header_limit", "limit_exceeded"),
        ("whole_limit", "limit_exceeded"), ("request_limit", "limit_exceeded"),
        ("invalid_request_limit", "invalid_request"), ("null", "r_error"),
        ("integer", "r_error"), ("final_valid", None),
        ("method_header", "invalid_request"), ("scalar_newline", "invalid_request"),
        ("scalar_cr", "invalid_request"), ("null_request_limit", "invalid_request"),
        ("raw_error", "r_error"), ("header_error", "r_error"),
        ("scalar_header_error", "r_error"), ("header_once", None),
    ]
    valid_packets = errors = 0
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        with open(ready, "w", encoding="utf-8") as output:
            output.write("tcp://127.0.0.1:%d\n" % listener.getsockname()[1])
        with listener.accept()[0] as connection:
            connection.settimeout(15)
            stream = connection.makefile("rb")

            def exchange(case, expected, request_id):
                nonlocal valid_packets, errors
                maximum = 0 if case in ("empty", "request_limit") else 10485760
                if case == "invalid_request_limit":
                    maximum = "4"
                if case == "null_request_limit":
                    maximum = None
                request = {"id": request_id, "method": "table/rows", "params": {
                    "view": "binary-view", "generation": 1,
                    "case": case, "max_bytes": maximum,
                }}
                connection.sendall(json.dumps(request).encode() + b"\n")
                while True:
                    response = json.loads(stream.readline())
                    if response.get("method") != "ack":
                        break
                assert response["id"] == request_id, response
                if expected:
                    assert response["error"]["code"] == expected, (case, response)
                    assert "result" not in response, response
                    errors += 1
                else:
                    transfer = response["result"]["transfer"]
                    assert transfer["encoding"] == "arrow-ipc", response
                    n = transfer["byte_length"]
                    payload = stream.read(n)
                    assert payload == (b"" if case == "empty" else bytes([0, 10, 255, 1])), (case, payload)
                    valid_packets += 1

            for index, (case, expected) in enumerate(cases):
                exchange(case, expected, index * 2)
                # A distinct request proves each terminal was sent exactly once.
                exchange("valid", None, index * 2 + 1)
    temporary = result + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({"ok": True, "cases": len(cases), "errors": errors,
                   "valid_packets": valid_packets, "ordered": True}, output)
    os.replace(temporary, result)


if __name__ == "__main__":
    main()
