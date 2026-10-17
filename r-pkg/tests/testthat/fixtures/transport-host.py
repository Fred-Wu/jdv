#!/usr/bin/env python3
"""Small Unix-domain JSON Lines (JSONL) peer used by the R transport integration test."""

import argparse
import json
import os
import select
import socket
import time


def read_message(stream):
    line = stream.readline()
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


def write_message(connection, value):
    connection.sendall(
        json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
    )


def write_result(path, value):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as result:
        json.dump(value, result)
        result.flush()
        os.fsync(result.fileno())
    os.replace(temporary, path)


def read_message_timeout(connection, stream, timeout):
    line = stream.readline(timeout=timeout)
    if not line:
        return None
    return json.loads(line.decode("utf-8"))


class JSONLStream:
    def __init__(self, connection):
        self.connection = connection
        self.buffer = bytearray()
        self.eof = False
        self.acks = []
        self.last_ack = 0

    def readline(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[: newline + 1])
                del self.buffer[: newline + 1]
                return line
            if self.eof:
                if self.buffer:
                    line = bytes(self.buffer)
                    self.buffer.clear()
                    return line
                return b""
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return None
            ready, _, _ = select.select([self.connection], [], [], remaining)
            if not ready:
                return None
            chunk = self.connection.recv(65536)
            if not chunk:
                self.eof = True
            else:
                self.buffer.extend(chunk)

    def read_response(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return None
            line = self.readline(timeout=remaining)
            if line is None:
                return None
            if not line:
                return False
            message = json.loads(line.decode("utf-8"))
            if message.get("method") == "ack":
                frames = message.get("params", {}).get("frames")
                if not isinstance(frames, int) or frames < self.last_ack:
                    raise RuntimeError("invalid or decreasing frame acknowledgement")
                self.last_ack = frames
                self.acks.append(message)
                continue
            return message


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--ready", required=True)
    parser.add_argument("--scenario", default="basic")
    parser.add_argument("--request-bytes", type=int, default=1024 * 1024)
    parser.add_argument("--queue-messages", type=int, default=256)
    parser.add_argument("--queue-bytes", type=int, default=16 * 1024 * 1024)
    parser.add_argument("--control", default="")
    args = parser.parse_args()

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(1)
    with open(args.ready, "w", encoding="utf-8"):
        pass
    with server:
        connection, _ = server.accept()
        with connection:
            stream = JSONLStream(connection)
            if args.scenario == "silent":
                time.sleep(2)
                return
            hello_line = stream.readline()
            opened_line = stream.readline()
            hello = json.loads(hello_line.decode("utf-8")) if hello_line else None
            opened = json.loads(opened_line.decode("utf-8")) if opened_line else None
            if hello is None or opened is None:
                raise RuntimeError("connection ended before hello and view/open")
            if hello.get("method") != "hello" or opened.get("method") != "view/open":
                raise RuntimeError("unexpected connection setup message order")
            params = opened["params"]
            if args.scenario == "notifications":
                messages = [hello, opened]
                while True:
                    message = stream.read_response(timeout=10)
                    if message is False:
                        break
                    if message is None:
                        raise RuntimeError("notification connection did not close")
                    messages.append(message)
                write_result(args.result, {"messages": messages})
                return
            if args.scenario == "disconnect":
                write_result(args.result, {"hello": hello, "open": opened, "responses": []})
                return
            if args.scenario == "close-on-command":
                write_result(args.result, {"hello": hello, "open": opened})
                deadline = time.monotonic() + 10
                while not os.path.exists(args.control) and time.monotonic() < deadline:
                    time.sleep(0.001)
                if not os.path.exists(args.control):
                    raise RuntimeError("close command was not received")
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
                write_result(args.result + ".closed", True)
                return
            if args.scenario == "preflight-frame":
                request = {
                    "id": "preflight-schema-1",
                    "method": "view/schema",
                    "params": {
                        "view": params["view"],
                        "generation": params["generation"],
                    },
                }
                write_message(connection, request)
                write_result(args.result + ".sent", True)
                response = None
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    message = stream.read_response(timeout=0.1)
                    if message is False:
                        response = False
                        break
                    if message is not None and "id" in message:
                        response = message
                        break
                write_result(args.result, {
                    "hello": hello,
                    "open": opened,
                    "response": response,
                })
                return
            request = {
                "id": "mock-rows-1",
                "method": "table/rows",
                "params": {
                    "view": params["view"],
                    "generation": params["generation"],
                    "offset": 0,
                    "limit": 2,
                },
            }
            if args.scenario == "large-response":
                # Keep framing coverage independent of implicit page sizing.
                request["params"]["cols"] = [0]
            payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
            expected_ids = ["mock-rows-1"]
            queue_info = {}
            if args.scenario == "large-snapshot":
                expected_ids = []
            elif args.scenario == "active-unload":
                request["id"] = "active-unload"
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
                responses = []
                disconnected = False
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    response = stream.read_response(timeout=0.1)
                    if response is None:
                        continue
                    if response is False:
                        disconnected = True
                        break
                    responses.append(response)
                if not disconnected:
                    raise RuntimeError("active package unload did not stop the transport")
                write_result(args.result, {
                        "hello": hello,
                        "open": opened,
                        "responses": responses,
                        "disconnected": True,
                    })
                return
            elif args.scenario == "empty-registry-close":
                request = {
                    "id": "close-table",
                    "method": "view/close",
                    "params": {
                        "view": params["view"],
                        "generation": params["generation"],
                    },
                }
                expected_ids = ["close-table"]
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
            elif args.scenario in ("queue-overflow-count", "queue-overflow-bytes"):
                frames = []
                accepted_ids = []
                rejected_ids = []
                frame_bytes = []
                queued_bytes = 0
                for index in range(1, 6):
                    queued_request = {
                        "id": f"overflow-{index}",
                        "method": "view/schema",
                        "params": {
                            "view": params["view"],
                            "generation": params["generation"],
                        },
                        "padding": "x" * 400,
                    }
                    frame = (
                        json.dumps(queued_request, separators=(",", ":")).encode("utf-8")
                        + b"\n"
                    )
                    request_bytes = len(frame) - 1
                    frame_bytes.append(request_bytes)
                    if (
                        len(accepted_ids) < args.queue_messages
                        and queued_bytes + request_bytes <= args.queue_bytes
                    ):
                        accepted_ids.append(queued_request["id"])
                        queued_bytes += request_bytes
                    else:
                        rejected_ids.append(queued_request["id"])
                    frames.append(frame)
                if not accepted_ids or not rejected_ids:
                    raise RuntimeError("queue-overflow scenario did not reach both bounds")
                expected_ids = rejected_ids + accepted_ids
                queue_info = {
                    "queue_accepted_ids": accepted_ids,
                    "queue_rejected_ids": rejected_ids,
                    "queue_frame_bytes": frame_bytes,
                }
                connection.sendall(b"".join(frames))
            elif args.scenario == "duplicate-id":
                request["id"] = "duplicate-live-id"
                frame = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                connection.sendall(frame + frame)
                responses = []
                disconnected = False
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    ready, _, _ = select.select([connection], [], [], 0.1)
                    if not ready:
                        continue
                    response = stream.read_response(timeout=0.1)
                    if response is None:
                        if stream.eof:
                            disconnected = True
                            break
                        continue
                    if response is False:
                        disconnected = True
                        break
                    responses.append(response)
                if not disconnected:
                    raise RuntimeError("duplicate live ids did not close the connection")
                write_result(args.result, {
                        "hello": hello,
                        "open": opened,
                        "responses": responses,
                        "disconnected": True,
                    })
                return
            elif args.scenario == "numeric-id":
                request["id"] = 1000000000000000
                expected_ids = [1000000000000000]
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
            elif args.scenario == "invalid-control":
                request["id"] = "invalid-control"
                request["params"] = {"view": params["view"]}
                expected_ids = ["invalid-control"]
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
            elif args.scenario in ("stale-generation", "missing-table"):
                request["id"] = args.scenario
                if args.scenario == "stale-generation":
                    request["params"]["generation"] += 1
                else:
                    request["params"]["view"] = "missing-view"
                expected_ids = [args.scenario]
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
            elif args.scenario == "ack-controls":
                request["id"] = "ack-cancel"
                cancel = {"method": "cancel", "params": {"id": "ack-cancel"}}
                wake = {"method": "wake"}
                frames = [
                    json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
                    for value in (request, cancel, wake)
                ]
                expected_ids = [None, "ack-cancel"]
                connection.sendall(b"".join(frames) + b'{"id":}\n')
            elif args.scenario == "invalid-cancel":
                request["id"] = "must-survive"
                expected_ids = [None, "must-survive"]
                connection.sendall(
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                )
                connection.sendall(
                    b'{"method":"cancel","params":{"id":1.0}}\n'
                )
            elif args.scenario in (
                "invalid-encoding-cancel",
                "invalid-compression-cancel",
                "invalid-deadline-cancel",
                "malformed-deadline-cancel",
                "expired-cancel",
                "typed-id",
                "cancel-id-reuse",
            ):
                if args.scenario == "cancel-id-reuse":
                    request["id"] = "reused"
                    cancel = {
                        "method": "cancel",
                        "params": {"id": "reused"},
                        "encoding": "json",
                        "compression": "none",
                        "deadline": time.time() + 10,
                    }
                    followup = {
                        "id": "followup",
                        "method": "view/schema",
                        "params": {
                            "view": params["view"],
                            "generation": params["generation"],
                        },
                    }
                    frame = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                    cancel_frame = json.dumps(cancel, separators=(",", ":")).encode("utf-8") + b"\n"
                    followup_frame = json.dumps(followup, separators=(",", ":")).encode("utf-8") + b"\n"
                    connection.sendall(frame + cancel_frame + frame + cancel_frame + followup_frame)
                    expected_ids = ["reused", "reused", "followup"]
                elif args.scenario == "typed-id":
                    request["id"] = 1
                    control = {"method": "cancel", "params": {"id": "1"}}
                    expected_ids = [1]
                else:
                    request["id"] = "protected"
                    control = {"method": "cancel", "params": {"id": "protected"}}
                    if args.scenario == "invalid-encoding-cancel":
                        control["encoding"] = "unsupported"
                    elif args.scenario == "invalid-compression-cancel":
                        control["compression"] = "unsupported"
                    elif args.scenario == "invalid-deadline-cancel":
                        control["deadline"] = "invalid"
                    elif args.scenario == "malformed-deadline-cancel":
                        control["deadline"] = []
                    else:
                        control["deadline"] = time.time() - 1
                    expected_ids = ["protected", "followup"]
                    if args.scenario in (
                        "invalid-deadline-cancel",
                        "malformed-deadline-cancel",
                    ):
                        expected_ids = [None, "protected", "followup"]
                if args.scenario != "cancel-id-reuse":
                    connection.sendall(
                        json.dumps(request, separators=(",", ":")).encode("utf-8")
                        + b"\n"
                        + json.dumps(control, separators=(",", ":")).encode("utf-8")
                        + b"\n"
                    )
                if args.scenario not in ("typed-id", "cancel-id-reuse"):
                    time.sleep(0.2)
                    followup = {
                        "id": "followup",
                        "method": "view/schema",
                        "params": {
                            "view": params["view"],
                            "generation": params["generation"],
                        },
                    }
                    connection.sendall(
                        json.dumps(followup, separators=(",", ":")).encode("utf-8")
                        + b"\n"
                    )
            elif args.scenario == "fragmented":
                for chunk in (payload[:1], payload[1:3], payload[3:]):
                    connection.sendall(chunk)
                    time.sleep(0.01)
            elif args.scenario == "maximum-frame":
                request = {
                    "id": "maximum-frame",
                    "method": "view/schema",
                    "params": {
                        "view": params["view"],
                        "generation": params["generation"],
                    },
                    "padding": "",
                }
                encoded = json.dumps(request, separators=(",", ":")).encode("utf-8")
                request["padding"] = "x" * max(0, args.request_bytes - len(encoded))
                payload = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                if len(payload) != args.request_bytes + 1:
                    raise RuntimeError("failed to construct the configured maximum frame")
                expected_ids = ["maximum-frame"]
                connection.sendall(payload)
            elif args.scenario in ("cancel", "expired"):
                request["id"] = "cancel-me" if args.scenario == "cancel" else "expire-me"
                if args.scenario == "expired":
                    request["deadline"] = time.time() + 0.1
                frames = [
                    json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\n"
                ]
                if args.scenario == "cancel":
                    frames.append(
                        json.dumps({
                            "method": "cancel",
                            "params": {"id": "cancel-me"},
                            "encoding": "json",
                            "compression": "none",
                            "deadline": time.time() + 10,
                            "future": "ignored",
                        }, separators=(",", ":")).encode("utf-8") + b"\n"
                    )
                connection.sendall(b"".join(frames))
                time.sleep(0.25)
                followup = {
                    "id": "followup",
                    "method": "view/schema",
                    "params": {
                        "view": params["view"],
                        "generation": params["generation"],
                    },
                }
                connection.sendall(
                    json.dumps(followup, separators=(",", ":")).encode("utf-8") + b"\n"
                )
                expected_ids = [
                    "cancel-me" if args.scenario == "cancel" else "expire-me",
                    "followup",
                ]
            else:
                connection.sendall(payload)

            responses = []
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and len(responses) < len(expected_ids):
                response = stream.read_response(timeout=0.1)
                if response is False:
                    break
                if response is not None:
                    responses.append(response)
            if args.scenario == "ack-controls":
                deadline = time.monotonic() + 2
                while stream.last_ack < 4 and time.monotonic() < deadline:
                    response = stream.read_response(timeout=0.1)
                    if response not in (None, False):
                        raise RuntimeError("unexpected extra business response")
            if [response.get("id") for response in responses] != expected_ids:
                write_result(args.result, {
                    "hello": hello,
                    "open": opened,
                    "responses": responses,
                    "acks": stream.acks,
                    "expected_ids": expected_ids,
                    "actual_ids": [response.get("id") for response in responses],
                })
                closed = stream.read_response()
                if closed is False:
                    closed = None
                write_result(args.result + ".closed", closed)
                return
            opened_params = opened["params"]
            data = opened_params.get("data") or {}
            columns = data.get("columns", [])
            value_count = sum(
                len(
                    column.get("values") or column.get("display", [])
                )
                for column in columns
            )
            node_count = len(data.get("row_index", [])) + sum(
                len(channel)
                for column in columns
                for channel in column.values()
                if isinstance(channel, list)
            )
            write_result(args.result, {
                    "hello": hello,
                    "open": opened,
                    "open_wire_bytes": len(opened_line),
                    "snapshot_value_count": value_count,
                    "snapshot_node_count": node_count,
                    "responses": responses,
                    "acks": stream.acks,
                    **queue_info,
                })
            closed = stream.read_response()
            if closed is False:
                closed = None
            write_result(args.result + ".closed", closed)


if __name__ == "__main__":
    main()
