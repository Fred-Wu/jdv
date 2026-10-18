#!/usr/bin/env python3
"""Check lifecycle JSONL, binary responses, and following JSONL on one socket."""

import json
import os
import socket
import sys


def main():
    ready, result = sys.argv[1:]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(15)
        with open(ready, "w", encoding="utf-8") as output:
            output.write("tcp://127.0.0.1:%d\n" % listener.getsockname()[1])
        with listener.accept()[0] as connection:
            connection.settimeout(15)
            stream = connection.makefile("rb")
            hello = json.loads(stream.readline())
            opened = json.loads(stream.readline())
            assert hello["method"] == "hello", hello
            assert hello["params"]["limits"]["max_message_bytes"] > 0, hello
            assert opened["method"] == "view/open", opened
            view = opened["params"]["view"]
            generation = opened["params"]["generation"]

            def send(request_id, method, maximum):
                connection.sendall(json.dumps({"id": request_id, "method": method,
                    "params": {"view": view, "generation": generation, "max_bytes": maximum}
                }).encode() + b"\n")

            def read():
                while True:
                    value = json.loads(stream.readline())
                    if value.get("method") != "ack":
                        return value

            send(1, "grid/rows", 4)
            closed = read()
            while closed.get("method") == "view/open":
                # Another view registered after the first one announces itself.
                closed = read()
            assert closed.get("method") == "view/closed", closed
            header = read()
            assert header["id"] == 1, header
            assert header["warnings"] == ["binary integration warning"], header
            assert header["result"]["transfer"]["byte_length"] == 4, header
            assert stream.read(4) == bytes([0, 10, 255, 1])
            send(2, "grid/rows", 0)
            error = read()
            assert error["id"] == 2 and error["error"]["code"] == "limit_exceeded", error
            send(3, "view/schema", 4)
            schema = read()
            assert schema["id"] == 3 and schema["result"]["view"] == view, schema
    temporary = result + ".tmp"
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump({"ok": True, "closed": closed["params"]["view"], "ordered": True}, output)
    os.replace(temporary, result)


if __name__ == "__main__":
    main()
