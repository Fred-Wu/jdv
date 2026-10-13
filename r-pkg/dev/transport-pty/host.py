#!/usr/bin/env python3
"""Bounded local NDJSON host for the interactive transport PTY harness."""

import argparse
import json
import os
from pathlib import Path
import socket
import time


def read_message(stream):
    line = stream.readline()
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


def write_message(connection, value):
    connection.sendall(json.dumps(value, separators=(",", ":")).encode() + b"\n")


def receive_open(connection):
    stream = connection.makefile("rb")
    hello = read_message(stream)
    opened = read_message(stream)
    if not isinstance(hello, dict) or hello.get("method") != "hello":
        raise RuntimeError("expected hello as the first message")
    if not isinstance(opened, dict) or opened.get("method") != "table/open":
        raise RuntimeError("expected table/open after hello")
    return stream, hello, opened


def rows_request(opened, request_id):
    params = opened["params"]
    return {
        "id": request_id,
        "method": "table/rows",
        "params": {
            "table": params["table"],
            "generation": params["generation"],
            "offset": 0,
            "limit": 64,
        },
    }


def accept_one(server, timeout):
    server.settimeout(timeout)
    connection, _ = server.accept()
    connection.settimeout(timeout)
    return connection


def run_rows(connection, opened, count, sent_path):
    stream = connection.makefile("rb")
    responses = []
    for index in range(count):
        request_id = f"rows-{index + 1}"
        write_message(connection, rows_request(opened, request_id))
        if index == 0:
            write_message(connection, {"method": "wake"})
        if sent_path is not None:
            Path(sent_path).write_text("sent\n", encoding="utf-8")
            sent_path = None
        response = read_message(stream)
        if response is None:
            break
        responses.append(response)
    return responses


def observe_close(connection, stream):
    messages = []
    while True:
        message = read_message(stream)
        if message is None:
            break
        messages.append(message)
    return messages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--transport", choices=("uds", "tcp"), default="uds")
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--ready", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--sent")
    parser.add_argument("--trigger")
    parser.add_argument("--timeout", type=float, default=12.0)
    args = parser.parse_args()
    ready = Path(args.ready)
    result = Path(args.result)
    timeout = min(max(args.timeout, 1.0), 30.0)

    server = socket.socket(socket.AF_UNIX if args.transport == "uds" else socket.AF_INET,
                           socket.SOCK_STREAM)
    if args.transport == "uds":
        endpoint = str(ready.parent / "jdv.sock")
        server.bind(endpoint)
        address = f"unix://{endpoint}"
    else:
        server.bind(("127.0.0.1", 0))
        host, port = server.getsockname()
        address = f"tcp://{host}:{port}"
    server.listen(2)
    ready.write_text(address, encoding="utf-8")

    records = {"transport": args.transport, "scenario": args.scenario, "connections": []}
    try:
        if args.scenario == "unload":
            for _ in range(2):
                with accept_one(server, timeout) as connection:
                    stream, hello, opened = receive_open(connection)
                    closed = observe_close(connection, stream)
                    records["connections"].append({"hello": hello, "open": opened, "closed": closed})
        else:
            with accept_one(server, timeout) as connection:
                stream, hello, opened = receive_open(connection)
                records["connections"].append({"hello": hello, "open": opened})
                if args.trigger is not None:
                    trigger = Path(args.trigger)
                    deadline = time.monotonic() + timeout
                    while not trigger.exists():
                        if time.monotonic() >= deadline:
                            raise TimeoutError("driver did not release the host request")
                        time.sleep(0.01)
                if args.scenario == "reentry":
                    responses = []
                    write_message(connection, rows_request(opened, "rows-1"))
                    write_message(connection, {"method": "wake"})
                    time.sleep(0.08)
                    write_message(connection, rows_request(opened, "rows-2"))
                    for _ in range(2):
                        response = read_message(stream)
                        if response is None:
                            break
                        responses.append(response)
                    records["responses"] = responses
                elif args.scenario == "close":
                    write_message(connection, rows_request(opened, "rows-1"))
                    write_message(connection, {"method": "wake"})
                    try:
                        records["close_messages"] = observe_close(connection, stream)
                    except (ConnectionError, OSError, TimeoutError):
                        records["close_messages"] = []
                    records["eof_observed"] = True
                else:
                    count = 2 if args.scenario == "interrupt" else 1
                    records["responses"] = run_rows(connection, opened, count, args.sent)
        result.write_text(json.dumps(records, indent=2), encoding="utf-8")
    finally:
        server.close()
        if args.transport == "uds":
            try:
                os.unlink(address.removeprefix("unix://"))
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()
