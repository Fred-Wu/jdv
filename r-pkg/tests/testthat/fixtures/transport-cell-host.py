#!/usr/bin/env python3
"""JSONL socket peer for cell lifecycle notification ordering and failures."""

import argparse
import json
import os
import socket
import time


def main():
    parser = argparse.ArgumentParser()
    for name in ("socket", "ready", "result", "control", "scenario"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    messages = []
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(args.socket)
        server.listen(1)
        open(args.ready, "w").close()
        connection, _ = server.accept()
        with connection, connection.makefile("rb") as stream:
            connection.settimeout(15)

            def read():
                line = stream.readline()
                if not line:
                    return None
                value = json.loads(line)
                messages.append(value)
                return value

            def send(value):
                connection.sendall(json.dumps(value).encode() + b"\n")

            def until_ack(count, response_id=None):
                while True:
                    value = read()
                    if value is None:
                        return False
                    if any(item.get("method") == "ack" and item["params"]["frames"] >= count for item in messages) and (response_id is None or any(item.get("id") == response_id for item in messages)):
                        return True

            hello, anchor, parent = read(), read(), read()
            assert hello["method"] == "hello"
            assert anchor["method"] == parent["method"] == "view/open"
            params = parent["params"]
            send({"id": "open", "method": "object/open", "params": {
                "view": params["view"], "generation": params["generation"],
                "path": [{"kind": "cell", "source_row": 0, "column": 0}]}})
            assert until_ack(1, "open")
            open(args.control + ".stage", "w").close()
            deadline = time.monotonic() + 15
            while not os.path.exists(args.control) and time.monotonic() < deadline:
                time.sleep(0.005)
            assert os.path.exists(args.control)
            if args.scenario == "disconnect":
                connection.shutdown(socket.SHUT_RDWR)
            else:
                send({"method": "wake", "params": {}})
                if args.scenario in ("success", "encode_failure"):
                    if args.scenario == "success":
                        while sum(item.get("method") == "view/closed" for item in messages) < 2:
                            assert read() is not None
                    send({"id": "close", "method": "view/close", "params": {
                        "view": params["view"], "generation": params["generation"]}})
                    assert until_ack(3, "close")
                else:
                    while read() is not None:
                        pass
            with open(args.result + ".tmp", "w", encoding="utf-8") as output:
                json.dump({"messages": messages}, output)
            os.replace(args.result + ".tmp", args.result)


if __name__ == "__main__":
    main()
