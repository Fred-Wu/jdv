#include "transport.h"
#include "json.h"
#include "cjson/cJSON.h"

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>
#include <R_ext/GraphicsDevice.h>
#include <R_ext/Utils.h>

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET jdv_socket;
#define JDV_INVALID_SOCKET INVALID_SOCKET
#define JDV_SOCKET_CLOSE closesocket
static int winsock_started = 0;
#else
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
typedef int jdv_socket;
#define JDV_INVALID_SOCKET (-1)
#define JDV_SOCKET_CLOSE close
#endif

#define JDV_DEFAULT_QUEUE_MESSAGES 256
#define JDV_DEFAULT_QUEUE_BYTES (16u * 1024u * 1024u)
#define JDV_DEFAULT_REQUEST_BYTES (1024u * 1024u)
#define JDV_DEFAULT_MESSAGE_BYTES (10u * 1024u * 1024u)
#define JDV_DEFAULT_DRAIN_REQUESTS 8
#define JDV_DEFAULT_SEND_TIMEOUT_MS 1000
#define JDV_DEFAULT_RECEIVE_MIN (64u * 1024u)
#define JDV_MAX_SAFE_INTEGER UINT64_C(9007199254740991)
#define JDV_ID_JSON_CAPACITY 800
#define JDV_ID_VALUE_CAPACITY 129
#define JDV_TABLE_ID_CAPACITY 512

typedef struct {
    char *json;
    size_t length;
    char id_json[JDV_ID_JSON_CAPACITY];
    char id_value[JDV_ID_VALUE_CAPACITY];
    int id_kind;
    char table[JDV_TABLE_ID_CAPACITY];
    double generation;
    double deadline;
    int has_deadline;
    int cancelled;
} jdv_request;

struct jdv_transport_state {
    jdv_socket socket;
#ifdef _WIN32
    HANDLE pipe;
#endif
    int connected;
    int source_active;
    int busy;
    int sending;
    int closing;
    int pending_free;
    int pending_disconnect;
    int disconnect_called;
    int pending_close;
    uint64_t epoch;
    size_t holds;
    char *read_buffer;
    size_t read_length;
    size_t read_capacity;
    jdv_request *queue;
    size_t queue_capacity;
    size_t queue_head;
    size_t queue_count;
    size_t queue_bytes;
    size_t receive_frames;
    uint64_t total_receive_frames;
    uint64_t last_ack_frames;
    size_t invalid_frames;
    size_t max_queue_messages;
    size_t max_queue_bytes;
    size_t max_request_bytes;
    size_t max_message_bytes;
    size_t max_receive_bytes;
    size_t max_drain_requests;
    unsigned int send_timeout_ms;
    size_t last_receive_bytes;
    SEXP request_callback;
    SEXP disconnect_callback;
    SEXP frame_call;
};

static jdv_transport_state *active_state = NULL;
static jdv_transport_state *retiring_state = NULL;
static uint64_t next_epoch = 1;
static int dispatch_depth = 0;
static int gate_depth = 0;
static int housekeeping_depth = 0;
static int construction_depth = 0;
static int reclamation_depth = 0;
static int drain_depth = 0;
static int construction_cancelled = 0;

typedef SEXP (*jdv_entry_body_fn)(void *);

typedef struct {
    jdv_entry_body_fn body;
    void *data;
} jdv_entry_call;

static SEXP native_entry_body(void *data)
{
    jdv_entry_call *call = (jdv_entry_call *)data;
    return call->body(call->data);
}

static void release_native_entry(void *data)
{
    (void)data;
    jdv_module_leave();
}

static SEXP with_native_entry(jdv_entry_body_fn body, void *data)
{
    jdv_entry_call call;
    call.body = body;
    call.data = data;
    jdv_module_enter();
    return R_ExecWithCleanup(native_entry_body, &call,
                             release_native_entry, &call);
}

typedef enum {
    JDV_FAILURE_NONE = 0,
    JDV_FAILURE_INTERRUPTED = 1,
    JDV_FAILURE_R_ERROR = 2,
    JDV_FAILURE_UNKNOWN = 3
} jdv_failure;

typedef struct {
    jdv_transport_state *state;
    jdv_request request;
    jdv_request *request_source;
    SEXP callback_continuation;
    SEXP frame_continuation;
    jdv_failure failure;
    SEXP response;
    int response_is_string;
    int background;
} jdv_dispatch;

typedef struct {
    jdv_transport_state *state;
    Rboolean previous_suspend;
    int nframe;
    int valid;
} jdv_gate;

static void free_state(jdv_transport_state *state);
static void free_state_now(jdv_transport_state *state);
static void state_hold(jdv_transport_state *state);
static void state_release(jdv_transport_state *state);
static void stop_connection(jdv_transport_state *state, int notify);
static void service_state(jdv_transport_state *state, int allow_gate,
                          size_t receive_budget, size_t drain_budget);

static int checked_limit(SEXP limits, const char *name, size_t fallback,
                         size_t minimum, size_t maximum, size_t *out)
{
    SEXP names = Rf_getAttrib(limits, R_NamesSymbol);
    R_xlen_t i;
    if (TYPEOF(limits) != VECSXP || TYPEOF(names) != STRSXP) return 0;
    for (i = 0; i < XLENGTH(limits); ++i) {
        if (STRING_ELT(names, i) == NA_STRING) continue;
        if (strcmp(CHAR(STRING_ELT(names, i)), name) == 0) {
            SEXP value = VECTOR_ELT(limits, i);
            double number;
            if (TYPEOF(value) == INTSXP && XLENGTH(value) == 1 &&
                INTEGER(value)[0] != NA_INTEGER) {
                number = INTEGER(value)[0];
            } else if (TYPEOF(value) == REALSXP && XLENGTH(value) == 1 &&
                       R_FINITE(REAL(value)[0])) {
                number = REAL(value)[0];
            } else {
                return 0;
            }
            if (number < (double)minimum || number > (double)maximum ||
                floor(number) != number) return 0;
            *out = (size_t)number;
            return 1;
        }
    }
    *out = fallback;
    return 1;
}

static double wall_time_seconds(void)
{
#ifdef _WIN32
    FILETIME ft;
    ULARGE_INTEGER value;
    GetSystemTimeAsFileTime(&ft);
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    return (double)value.QuadPart / 10000000.0 - 11644473600.0;
#else
    struct timespec ts;
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return (double)time(NULL);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1000000000.0;
#endif
}

static double monotonic_seconds(void)
{
#ifdef _WIN32
    LARGE_INTEGER frequency;
    LARGE_INTEGER counter;
    if (QueryPerformanceFrequency(&frequency) &&
        QueryPerformanceCounter(&counter))
        return (double)counter.QuadPart / (double)frequency.QuadPart;
    {
        static DWORD last_tick = 0;
        static uint64_t extended_ticks = 0;
        DWORD current_tick = GetTickCount();
        if (current_tick < last_tick)
            extended_ticks += UINT64_C(1) << 32;
        last_tick = current_tick;
        return (double)(extended_ticks + (uint64_t)current_tick) / 1000.0;
    }
#else
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return (double)time(NULL);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1000000000.0;
#endif
}

static int set_nonblocking(jdv_socket socket)
{
#ifdef _WIN32
    u_long enabled = 1;
    return ioctlsocket(socket, FIONBIO, &enabled) == 0;
#else
    int flags = fcntl(socket, F_GETFL, 0);
    return flags >= 0 && fcntl(socket, F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

static int wait_socket(jdv_socket socket, int writing, unsigned int timeout_ms)
{
#ifdef _WIN32
    fd_set read_set, write_set;
    struct timeval timeout;
    FD_ZERO(&read_set);
    FD_ZERO(&write_set);
    if (writing) FD_SET(socket, &write_set);
    else FD_SET(socket, &read_set);
    timeout.tv_sec = (long)(timeout_ms / 1000u);
    timeout.tv_usec = (long)(timeout_ms % 1000u) * 1000L;
    return select(0, writing ? NULL : &read_set,
                  writing ? &write_set : NULL, NULL, &timeout) > 0;
#else
    struct pollfd descriptor;
    descriptor.fd = socket;
    descriptor.events = writing ? POLLOUT : POLLIN;
    descriptor.revents = 0;
    int result = poll(&descriptor, 1, (int)timeout_ms);
    return result > 0 && (descriptor.revents & (writing ? POLLOUT : POLLIN));
#endif
}

static int socket_error(jdv_socket socket)
{
    int error = 0;
#ifdef _WIN32
    int length = (int)sizeof(error);
    if (getsockopt(socket, SOL_SOCKET, SO_ERROR, (char *)&error, &length) != 0)
        return WSAGetLastError();
#else
    socklen_t length = (socklen_t)sizeof(error);
    if (getsockopt(socket, SOL_SOCKET, SO_ERROR, &error, &length) != 0)
        return errno;
#endif
    return error;
}

static int send_bytes_until(jdv_transport_state *state, const char *data,
                            size_t length, double deadline)
{
    size_t sent = 0;
    if (!state->connected) return 0;
#ifdef _WIN32
    if (state->pipe != INVALID_HANDLE_VALUE) {
        while (sent < length) {
            DWORD written = 0;
            size_t part = length - sent;
            if (monotonic_seconds() >= deadline) return 0;
            if (part > 65536) part = 65536;
            if (!WriteFile(state->pipe, data + sent, (DWORD)part, &written,
                           NULL)) return 0;
            if (written > 0) {
                sent += (size_t)written;
                continue;
            }
            if (monotonic_seconds() >= deadline) return 0;
            Sleep(1);
        }
        return 1;
    }
#endif
    while (sent < length) {
        int wait_ms;
        double remaining = deadline - monotonic_seconds();
        if (remaining <= 0) return 0;
        wait_ms = (int)ceil(remaining * 1000.0);
        if (wait_ms < 1) wait_ms = 1;
        if (!wait_socket(state->socket, 1, (unsigned int)wait_ms)) return 0;
#ifdef _WIN32
        int n = send(state->socket, data + sent,
                     (int)((length - sent) > INT_MAX ? INT_MAX : length - sent), 0);
        if (n == SOCKET_ERROR) {
            int error = WSAGetLastError();
            if (error == WSAEINTR || error == WSAEWOULDBLOCK) continue;
            return 0;
        }
#else
#ifdef MSG_NOSIGNAL
        ssize_t n = send(state->socket, data + sent, length - sent, MSG_NOSIGNAL);
#else
        ssize_t n = send(state->socket, data + sent, length - sent, 0);
#endif
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
            return 0;
        }
#endif
        if (n == 0) return 0;
        sent += (size_t)n;
    }
    return 1;
}

static int send_message(jdv_transport_state *state, const char *message,
                        size_t length)
{
    double deadline = monotonic_seconds() +
        (double)state->send_timeout_ms / 1000.0;
    double remaining;
    if (length > state->max_message_bytes) return 0;
    if (!send_bytes_until(state, message, length, deadline)) return 0;
    remaining = deadline - monotonic_seconds();
    if (remaining <= 0) return 0;
    return send_bytes_until(state, "\n", 1, deadline);
}

static int send_error(jdv_transport_state *state, const char *id_json,
                      const char *code, const char *message)
{
    char response[JDV_ID_JSON_CAPACITY + 512];
    int length;
    if (!state || !state->connected) return 0;
    if (!id_json || !id_json[0]) id_json = "null";
    length = snprintf(response, sizeof(response),
                      "{\"id\":%s,\"error\":{\"code\":\"%s\",\"message\":\"%s\"},\"warnings\":[]}",
                      id_json, code, message);
    if (length < 0 || (size_t)length >= sizeof(response)) {
        stop_connection(state, 1);
        return 0;
    }
    if (!send_message(state, response, (size_t)length)) {
        stop_connection(state, 1);
        return 0;
    }
    return 1;
}

static int send_ack(jdv_transport_state *state, uint64_t frames)
{
    char message[96];
    int length;
    if (!state || state != active_state || !state->connected ||
        state->closing || frames <= state->last_ack_frames ||
        frames > JDV_MAX_SAFE_INTEGER)
        return 0;
    length = snprintf(message, sizeof(message),
                      "{\"method\":\"ack\",\"params\":{\"frames\":%llu}}",
                      (unsigned long long)frames);
    if (length < 0 || (size_t)length >= sizeof(message) ||
        !send_message(state, message, (size_t)length)) {
        stop_connection(state, 1);
        return 0;
    }
    state->last_ack_frames = frames;
    return 1;
}

static int parse_port(const char *text, unsigned short *port)
{
    unsigned long value = 0;
    const unsigned char *p = (const unsigned char *)text;
    if (!*p) return 0;
    for (; *p; ++p) {
        if (!isdigit(*p)) return 0;
        value = value * 10 + (unsigned long)(*p - '0');
        if (value > 65535) return 0;
    }
    if (value == 0) return 0;
    *port = (unsigned short)value;
    return 1;
}

static int connect_tcp(jdv_transport_state *state, const char *address)
{
    const char *host_port = address + 6;
    const char *colon = strrchr(host_port, ':');
    char host[128];
    unsigned short port;
    struct sockaddr_in endpoint;
    jdv_socket socket_fd;
    int result;
    if (!colon || colon == host_port ||
        (size_t)(colon - host_port) >= sizeof(host) ||
        !parse_port(colon + 1, &port)) return 0;
    memcpy(host, host_port, (size_t)(colon - host_port));
    host[colon - host_port] = '\0';
    memset(&endpoint, 0, sizeof(endpoint));
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(port);
    if (strcmp(host, "localhost") == 0 || strcmp(host, "127.0.0.1") == 0)
        endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    else return 0;
#ifdef _WIN32
    if (!winsock_started) {
        WSADATA data;
        if (WSAStartup(MAKEWORD(2, 2), &data) != 0) return 0;
        winsock_started = 1;
    }
#endif
    socket_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (socket_fd == JDV_INVALID_SOCKET || !set_nonblocking(socket_fd)) {
        if (socket_fd != JDV_INVALID_SOCKET) JDV_SOCKET_CLOSE(socket_fd);
        return 0;
    }
    result = connect(socket_fd, (struct sockaddr *)&endpoint, sizeof(endpoint));
#ifdef _WIN32
    if (result != 0 && WSAGetLastError() != WSAEWOULDBLOCK &&
        WSAGetLastError() != WSAEINPROGRESS) {
        JDV_SOCKET_CLOSE(socket_fd);
        return 0;
    }
#else
    if (result != 0 && errno != EINPROGRESS && errno != EWOULDBLOCK) {
        JDV_SOCKET_CLOSE(socket_fd);
        return 0;
    }
#endif
    if (result != 0 &&
        (!wait_socket(socket_fd, 1, state->send_timeout_ms) ||
         socket_error(socket_fd) != 0)) {
        JDV_SOCKET_CLOSE(socket_fd);
        return 0;
    }
#ifndef _WIN32
#ifdef SO_NOSIGPIPE
    {
        int enabled = 1;
        (void)setsockopt(socket_fd, SOL_SOCKET, SO_NOSIGPIPE,
                         &enabled, sizeof(enabled));
    }
#endif
#endif
    state->socket = socket_fd;
    state->connected = 1;
    return 1;
}

#ifdef _WIN32
static int connect_pipe(jdv_transport_state *state, const char *address)
{
    const char *prefix = "npipe:////./pipe/";
    char path[512];
    const char *name;
    size_t n;
    HANDLE pipe;
    DWORD pipe_flags = 0;
    DWORD mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
    if (strncmp(address, prefix, strlen(prefix)) != 0) return 0;
    name = address + strlen(prefix);
    n = strlen(name);
    if (n == 0 || n > sizeof(path) - 10) return 0;
    snprintf(path, sizeof(path), "\\\\.\\pipe\\%s", name);
    pipe = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                       OPEN_EXISTING, 0, NULL);
    if (pipe == INVALID_HANDLE_VALUE) return 0;
    if (!GetNamedPipeInfo(pipe, &pipe_flags, NULL, NULL, NULL) ||
        (pipe_flags & PIPE_TYPE_MESSAGE) != 0 ||
        !SetNamedPipeHandleState(pipe, &mode, NULL, NULL)) {
        CloseHandle(pipe);
        return 0;
    }
    state->pipe = pipe;
    state->connected = 1;
    return 1;
}
#endif

static int connect_unix(jdv_transport_state *state, const char *address)
{
#ifndef _WIN32
    const char *path = address;
    struct sockaddr_un endpoint;
    size_t length;
    int result;
    if (strncmp(path, "unix://localhost/", 17) == 0) path += 16;
    else if (strncmp(path, "unix:///", 8) == 0) path += 7;
    else if (strncmp(path, "unix://", 7) == 0) return 0;
    if (*path != '/') return 0;
    length = strlen(path);
    if (length >= sizeof(endpoint.sun_path)) return 0;
    memset(&endpoint, 0, sizeof(endpoint));
    endpoint.sun_family = AF_UNIX;
    memcpy(endpoint.sun_path, path, length + 1);
    state->socket = socket(AF_UNIX, SOCK_STREAM, 0);
    if (state->socket == JDV_INVALID_SOCKET || !set_nonblocking(state->socket)) {
        if (state->socket != JDV_INVALID_SOCKET) JDV_SOCKET_CLOSE(state->socket);
        state->socket = JDV_INVALID_SOCKET;
        return 0;
    }
    result = connect(state->socket, (struct sockaddr *)&endpoint, sizeof(endpoint));
    if (result != 0 && errno != EINPROGRESS && errno != EWOULDBLOCK) {
        JDV_SOCKET_CLOSE(state->socket);
        state->socket = JDV_INVALID_SOCKET;
        return 0;
    }
    if (result != 0 &&
        (!wait_socket(state->socket, 1, state->send_timeout_ms) ||
         socket_error(state->socket) != 0)) {
        JDV_SOCKET_CLOSE(state->socket);
        state->socket = JDV_INVALID_SOCKET;
        return 0;
    }
#ifndef _WIN32
#ifdef SO_NOSIGPIPE
    {
        int enabled = 1;
        (void)setsockopt(state->socket, SOL_SOCKET, SO_NOSIGPIPE,
                         &enabled, sizeof(enabled));
    }
#endif
#endif
    state->connected = 1;
    return 1;
#else
    (void)state;
    (void)address;
    return 0;
#endif
}

static int connect_endpoint(jdv_transport_state *state, const char *address)
{
    if (strncmp(address, "tcp://", 6) == 0)
        return connect_tcp(state, address);
#ifdef _WIN32
    if (strncmp(address, "npipe:", 6) == 0)
        return connect_pipe(state, address);
#endif
    return connect_unix(state, address);
}

static void clear_queue(jdv_transport_state *state)
{
    size_t i;
    if (!state || !state->queue) return;
    for (i = 0; i < state->queue_capacity; ++i) {
        free(state->queue[i].json);
        memset(&state->queue[i], 0, sizeof(state->queue[i]));
    }
    state->queue_head = 0;
    state->queue_count = 0;
    state->queue_bytes = 0;
}

static void free_state_now(jdv_transport_state *state)
{
    if (!state) return;
    reclamation_depth++;
    if (active_state == state) active_state = NULL;
    if (retiring_state == state) retiring_state = NULL;
    if (state->source_active) jdv_loop_stop();
    state->source_active = 0;
    if (state->connected) {
#ifdef _WIN32
        if (state->pipe && state->pipe != INVALID_HANDLE_VALUE) {
            CloseHandle(state->pipe);
        }
#endif
        if (state->socket != JDV_INVALID_SOCKET)
            JDV_SOCKET_CLOSE(state->socket);
    }
    if (state->request_callback != R_NilValue)
        R_ReleaseObject(state->request_callback);
    if (state->disconnect_callback != R_NilValue)
        R_ReleaseObject(state->disconnect_callback);
    if (state->frame_call != R_NilValue)
        R_ReleaseObject(state->frame_call);
    clear_queue(state);
    free(state->queue);
    free(state->read_buffer);
    reclamation_depth--;
    free(state);
}

static void free_state(jdv_transport_state *state)
{
    if (!state) return;
    if (state->holds) {
        state->pending_free = 1;
        return;
    }
    free_state_now(state);
}

static void state_hold(jdv_transport_state *state)
{
    if (state) state->holds++;
}

static void state_release(jdv_transport_state *state)
{
    if (!state || state->holds == 0) return;
    state->holds--;
    if (state->holds == 0 && state->pending_free) free_state_now(state);
}

static void stop_connection(jdv_transport_state *state, int notify)
{
    if (!state) return;
    if (state->source_active) {
        jdv_loop_stop();
        state->source_active = 0;
    }
    if (state->connected) {
#ifdef _WIN32
        if (state->pipe && state->pipe != INVALID_HANDLE_VALUE) {
            CloseHandle(state->pipe);
            state->pipe = INVALID_HANDLE_VALUE;
        }
#endif
        if (state->socket != JDV_INVALID_SOCKET) {
            JDV_SOCKET_CLOSE(state->socket);
            state->socket = JDV_INVALID_SOCKET;
        }
    }
    state->connected = 0;
    state->closing = 1;
    state->pending_disconnect = notify;
    clear_queue(state);
    if (active_state == state) active_state = NULL;
    if (notify) retiring_state = state;
    else if (retiring_state == state) retiring_state = NULL;
}

static SEXP disconnect_eval(void *data)
{
    jdv_transport_state *state = (jdv_transport_state *)data;
    SEXP call = PROTECT(Rf_lang1(state->disconnect_callback));
    SEXP result = Rf_eval(call, R_GlobalEnv);
    UNPROTECT(1);
    return result;
}

static void disconnect_eval_boundary(void *data)
{
    (void)disconnect_eval(data);
}

static int run_disconnect_callback(jdv_transport_state *state)
{
    Rboolean ok;
    if (!state || !state->pending_disconnect || state->busy || state->holds ||
        dispatch_depth || housekeeping_depth) return 0;
    if (state->disconnect_called) return 1;
    housekeeping_depth++;
    state->disconnect_called = 1;
    ok = R_ToplevelExec(disconnect_eval_boundary, state);
    housekeeping_depth--;
    if (!ok) {
        state->disconnect_called = 0;
        return 0;
    }
    state->pending_disconnect = 0;
    state->pending_close = 0;
    free_state(state);
    return 1;
}

static SEXP status_for(jdv_transport_state *state)
{
    static const char *names[] = {
        "connected", "busy", "queued_messages", "queued_bytes",
        "receive_bytes", "source_active", "pending_cleanup", "pending_close",
        "epoch", "max_receive_frames", "max_receive_bytes",
        "queue_messages_limit", "queue_bytes_limit", "max_request_bytes"
    };
    int connected = state && state->connected;
    int busy = state && state->busy;
    double queued_messages = state ? (double)state->queue_count : 0.0;
    double queued_bytes = state ? (double)state->queue_bytes : 0.0;
    double receive_bytes = state ? (double)state->last_receive_bytes : 0.0;
    int source_active = state && state->source_active;
    int pending_cleanup = state && state->pending_disconnect;
    int pending_close = state && state->pending_close;
    double epoch = state ? (double)state->epoch : 0.0;
    double max_receive_frames = state ?
        (double)(state->max_queue_messages + state->max_drain_requests) : 0.0;
    double max_receive_bytes = state ? (double)state->max_receive_bytes : 0.0;
    double queue_messages_limit = state ?
        (double)state->max_queue_messages : 0.0;
    double queue_bytes_limit = state ? (double)state->max_queue_bytes : 0.0;
    double max_request_bytes = state ? (double)state->max_request_bytes : 0.0;
    SEXP result = PROTECT(Rf_allocVector(VECSXP, 14));
    SEXP result_names = PROTECT(Rf_allocVector(STRSXP, 14));
    for (int i = 0; i < 14; ++i)
        SET_STRING_ELT(result_names, i, Rf_mkChar(names[i]));
    SET_VECTOR_ELT(result, 0, Rf_ScalarLogical(connected));
    SET_VECTOR_ELT(result, 1, Rf_ScalarLogical(busy));
    SET_VECTOR_ELT(result, 2, Rf_ScalarReal(queued_messages));
    SET_VECTOR_ELT(result, 3, Rf_ScalarReal(queued_bytes));
    SET_VECTOR_ELT(result, 4, Rf_ScalarReal(receive_bytes));
    SET_VECTOR_ELT(result, 5, Rf_ScalarLogical(source_active));
    SET_VECTOR_ELT(result, 6, Rf_ScalarLogical(pending_cleanup));
    SET_VECTOR_ELT(result, 7, Rf_ScalarLogical(pending_close));
    SET_VECTOR_ELT(result, 8, Rf_ScalarReal(epoch));
    SET_VECTOR_ELT(result, 9, Rf_ScalarReal(max_receive_frames));
    SET_VECTOR_ELT(result, 10, Rf_ScalarReal(max_receive_bytes));
    SET_VECTOR_ELT(result, 11, Rf_ScalarReal(queue_messages_limit));
    SET_VECTOR_ELT(result, 12, Rf_ScalarReal(queue_bytes_limit));
    SET_VECTOR_ELT(result, 13, Rf_ScalarReal(max_request_bytes));
    Rf_setAttrib(result, R_NamesSymbol, result_names);
    UNPROTECT(2);
    return result;
}

static int numeric_id(cJSON *value, jdv_request *request)
{
    if (cJSON_IsString(value) && value->valuestring) {
        size_t n = strlen(value->valuestring);
        if (n > 128) return 0;
        memcpy(request->id_value, value->valuestring, n + 1);
        request->id_kind = 1;
    } else if (cJSON_IsNumber(value) && R_FINITE(value->valuedouble) &&
               value->valuedouble >= 0 &&
               value->valuedouble <= 9007199254740991.0 &&
               floor(value->valuedouble) == value->valuedouble) {
        int n = snprintf(request->id_value, sizeof(request->id_value), "%.0f",
                         value->valuedouble);
        if (n < 1 || (size_t)n >= sizeof(request->id_value)) return 0;
        request->id_kind = 2;
    } else {
        return 0;
    }
    char *printed = cJSON_PrintUnformatted(value);
    if (!printed) return 0;
    size_t printed_length = strlen(printed);
    if (printed_length >= sizeof(request->id_json)) {
        free(printed);
        return 0;
    }
    memcpy(request->id_json, printed, printed_length + 1);
    free(printed);
    return 1;
}

static int parse_request_metadata(const char *json, size_t length,
                                  jdv_request *request, int *control)
{
    char *terminated = (char *)malloc(length + 1);
    cJSON *root;
    cJSON *id;
    cJSON *method;
    cJSON *params;
    cJSON *table;
    cJSON *generation;
    cJSON *deadline;
    cJSON *encoding;
    cJSON *compression;
    if (!terminated) return 0;
    memcpy(terminated, json, length);
    terminated[length] = '\0';
    root = cJSON_ParseWithLength(terminated, length + 1);
    free(terminated);
    if (!root || !cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return 0;
    }
    *control = 0;
    id = cJSON_GetObjectItemCaseSensitive(root, "id");
    method = cJSON_GetObjectItemCaseSensitive(root, "method");
    params = cJSON_GetObjectItemCaseSensitive(root, "params");
    deadline = cJSON_GetObjectItemCaseSensitive(root, "deadline");
    encoding = cJSON_GetObjectItemCaseSensitive(root, "encoding");
    compression = cJSON_GetObjectItemCaseSensitive(root, "compression");
    if (id && !numeric_id(id, request)) {
        cJSON_Delete(root);
        return 0;
    }
    if (deadline) {
        if (!cJSON_IsNumber(deadline) || !R_FINITE(deadline->valuedouble)) {
            cJSON_Delete(root);
            return 0;
        }
        request->deadline = deadline->valuedouble;
        request->has_deadline = 1;
    }

    int supported_encoding = !encoding ||
        (cJSON_IsString(encoding) && encoding->valuestring &&
         strcmp(encoding->valuestring, "json") == 0);
    int supported_compression = !compression ||
        (cJSON_IsString(compression) && compression->valuestring &&
         strcmp(compression->valuestring, "none") == 0);
    int expired = request->has_deadline &&
        wall_time_seconds() >= request->deadline;
    if (method && cJSON_IsString(method) && method->valuestring && !id &&
        supported_encoding && supported_compression) {
        if (strcmp(method->valuestring, "wake") == 0 && !params) {
            *control = 1;
            cJSON_Delete(root);
            return 1;
        }
        if (strcmp(method->valuestring, "cancel") == 0 &&
            cJSON_IsObject(params)) {
            jdv_request cancel_id;
            cJSON *cancel_value = cJSON_IsObject(params) ?
                cJSON_GetObjectItemCaseSensitive(params, "id") : NULL;
            memset(&cancel_id, 0, sizeof(cancel_id));
            if (!numeric_id(cancel_value, &cancel_id)) {
                cJSON_Delete(root);
                return 0;
            }
            if (expired) {
                *control = 1;
            } else {
                request->id_kind = cancel_id.id_kind;
                memcpy(request->id_value, cancel_id.id_value,
                       sizeof(request->id_value));
                *control = 2;
            }
            cJSON_Delete(root);
            return 1;
        }
    }
    if (cJSON_IsObject(params)) {
        table = cJSON_GetObjectItemCaseSensitive(params, "table");
        generation = cJSON_GetObjectItemCaseSensitive(params, "generation");
        if (cJSON_IsString(table) && table->valuestring &&
            strlen(table->valuestring) < sizeof(request->table))
            memcpy(request->table, table->valuestring,
                   strlen(table->valuestring) + 1);
        if (cJSON_IsNumber(generation) && R_FINITE(generation->valuedouble))
            request->generation = generation->valuedouble;
    }
    cJSON_Delete(root);
    return 1;
}

static int same_id(const jdv_request *left, const jdv_request *right)
{
    return left->id_kind == right->id_kind &&
        strcmp(left->id_value, right->id_value) == 0;
}

static void cancel_pending(jdv_transport_state *state, const jdv_request *id)
{
    size_t i;
    if (!state) return;
    for (i = 0; i < state->queue_count; ++i) {
        size_t index = (state->queue_head + i) % state->queue_capacity;
        jdv_request *pending = &state->queue[index];
        if (pending->cancelled ||
            (pending->has_deadline &&
             wall_time_seconds() >= pending->deadline)) continue;
        if (same_id(pending, id)) {
            pending->cancelled = 1;
            return;
        }
    }
}

static void queue_pop(jdv_transport_state *state, jdv_request *out)
{
    *out = state->queue[state->queue_head];
    state->queue_bytes -= out->length;
    memset(&state->queue[state->queue_head], 0,
           sizeof(state->queue[state->queue_head]));
    state->queue_head = (state->queue_head + 1) % state->queue_capacity;
    state->queue_count--;
}

static int queue_request(jdv_transport_state *state, const char *line,
                         size_t length)
{
    jdv_request metadata;
    int control;
    size_t tail;
    size_t i;
    memset(&metadata, 0, sizeof(metadata));
    if (!jdv_json_validate((const unsigned char *)line, length,
                           state->max_request_bytes)) {
        send_error(state, "null", "invalid_request", "Invalid request.");
        return -1;
    }
    if (!parse_request_metadata(line, length, &metadata, &control)) {
        send_error(state, "null", "invalid_request", "Invalid request.");
        return -1;
    }
    if (control == 1) return 1;
    if (control == 2) {
        cancel_pending(state, &metadata);
        return 1;
    }
    if (metadata.id_kind != 0) {
        for (i = 0; i < state->queue_count; ++i) {
            size_t index = (state->queue_head + i) % state->queue_capacity;
            jdv_request *pending = &state->queue[index];
            if (pending->cancelled ||
                (pending->has_deadline &&
                 wall_time_seconds() >= pending->deadline)) continue;
            if (same_id(pending, &metadata)) {
                send_error(state, "null", "invalid_request",
                           "A request with this id is already pending.");
                return 0;
            }
        }
    }
    if (state->queue_count >= state->max_queue_messages ||
        length > state->max_queue_bytes - state->queue_bytes) {
        return send_error(state, metadata.id_json, "limit_exceeded",
                          "The request queue is full.") ? 1 : 0;
    }
    metadata.json = (char *)malloc(length + 1);
    if (!metadata.json) {
        send_error(state, metadata.id_json, "limit_exceeded",
                   "The request queue is full.");
        return 0;
    }
    memcpy(metadata.json, line, length);
    metadata.json[length] = '\0';
    metadata.length = length;
    tail = (state->queue_head + state->queue_count) % state->queue_capacity;
    state->queue[tail] = metadata;
    state->queue_count++;
    state->queue_bytes += length;
    return 1;
}

static void remove_first_line(jdv_transport_state *state)
{
    char *newline = (char *)memchr(state->read_buffer, '\n', state->read_length);
    size_t consumed;
    size_t length;
    int queued;
    if (!newline) return;
    length = (size_t)(newline - state->read_buffer);
    consumed = length + 1;
    if (state->total_receive_frames >= JDV_MAX_SAFE_INTEGER) {
        stop_connection(state, 1);
        return;
    }
    state->total_receive_frames++;
    if (length > state->max_request_bytes) {
        send_error(state, "null", "limit_exceeded",
                   "The request exceeds the configured byte limit.");
        stop_connection(state, 1);
        return;
    }
    state->receive_frames++;
    if (state->receive_frames >
        state->max_queue_messages + state->max_drain_requests) {
        send_error(state, "null", "limit_exceeded",
                   "The receive frame budget was exceeded.");
        stop_connection(state, 1);
        return;
    }
    queued = queue_request(state, state->read_buffer, length);
    if (queued < 0 && ++state->invalid_frames > state->max_drain_requests) {
        send_error(state, "null", "limit_exceeded",
                   "The invalid request budget was exceeded.");
        stop_connection(state, 1);
        return;
    }
    if (queued == 0) {
        stop_connection(state, 1);
        return;
    }
    state->read_length -= consumed;
    if (state->read_length)
        memmove(state->read_buffer, state->read_buffer + consumed,
                state->read_length);
}

static void append_received(jdv_transport_state *state, const char *bytes,
                            size_t length)
{
    if (length > state->read_capacity - state->read_length) {
        send_error(state, "null", "limit_exceeded",
                   "The request exceeds the configured byte limit.");
        stop_connection(state, 1);
        return;
    }
    memcpy(state->read_buffer + state->read_length, bytes, length);
    state->read_length += length;
    while (state->connected &&
           memchr(state->read_buffer, '\n', state->read_length)) {
        remove_first_line(state);
    }
    if (state->connected && state->read_length > state->max_request_bytes) {
        send_error(state, "null", "limit_exceeded",
                   "The request exceeds the configured byte limit.");
        stop_connection(state, 1);
    }
}

static int socket_read_ready(jdv_transport_state *state)
{
#ifdef _WIN32
    (void)state;
    return 0;
#else
    struct pollfd descriptor;
    descriptor.fd = state->socket;
    descriptor.events = POLLIN;
    descriptor.revents = 0;
    return poll(&descriptor, 1, 0) > 0 &&
        (descriptor.revents & (POLLIN | POLLHUP | POLLERR));
#endif
}

static size_t receive_socket(jdv_transport_state *state, size_t budget)
{
    size_t received = 0;
    char buffer[65536];
    if (!state->connected) return 0;
    state->receive_frames = 0;
    state->invalid_frames = 0;
#ifdef _WIN32
    if (state->pipe && state->pipe != INVALID_HANDLE_VALUE) {
        DWORD available = 0;
        if (!PeekNamedPipe(state->pipe, NULL, 0, NULL, &available, NULL)) {
            stop_connection(state, 1);
            return 0;
        }
        while (available > 0 && received < budget && state->connected) {
            DWORD read_bytes = 0;
            size_t capacity = budget - received;
            if (capacity > sizeof(buffer)) capacity = sizeof(buffer);
            if (capacity > available) capacity = available;
            if (capacity > state->read_capacity - state->read_length)
                capacity = state->read_capacity - state->read_length;
            if (capacity == 0) {
                send_error(state, "null", "limit_exceeded",
                           "The request exceeds the configured byte limit.");
                stop_connection(state, 1);
                break;
            }
            if (!ReadFile(state->pipe, buffer, (DWORD)capacity,
                          &read_bytes, NULL)) {
                DWORD error = GetLastError();
                if (error == ERROR_NO_DATA) break;
                else {
                    stop_connection(state, 1);
                    break;
                }
            }
            if (read_bytes == 0) break;
            received += (size_t)read_bytes;
            append_received(state, buffer, (size_t)read_bytes);
            if (!state->connected ||
                !PeekNamedPipe(state->pipe, NULL, 0, NULL, &available, NULL)) {
                if (state->connected) stop_connection(state, 1);
                break;
            }
        }
        if (state->connected && received >= budget && available > 0) {
            send_error(state, "null", "limit_exceeded",
                       "The receive budget was exceeded.");
            stop_connection(state, 1);
        }
        return received;
    }
#endif
    while (received < budget && state->connected) {
        size_t want = budget - received;
        if (want > sizeof(buffer)) want = sizeof(buffer);
        if (want > state->read_capacity - state->read_length)
            want = state->read_capacity - state->read_length;
        if (want == 0) {
            send_error(state, "null", "limit_exceeded",
                       "The request exceeds the configured byte limit.");
            stop_connection(state, 1);
            break;
        }
#ifdef _WIN32
        int n = recv(state->socket, buffer, (int)want, 0);
        if (n == SOCKET_ERROR) {
            int error = WSAGetLastError();
            if (error == WSAEINTR) continue;
            if (error == WSAEWOULDBLOCK) break;
            stop_connection(state, 1);
            break;
        }
#else
        ssize_t n = recv(state->socket, buffer, want, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            stop_connection(state, 1);
            break;
        }
#endif
        if (n == 0) {
            stop_connection(state, 1);
            break;
        }
        received += (size_t)n;
        append_received(state, buffer, (size_t)n);
    }
    if (state->connected && received >= budget && socket_read_ready(state)) {
        send_error(state, "null", "limit_exceeded",
                   "The receive budget was exceeded.");
        stop_connection(state, 1);
    }
    return received;
}

/* Remove every terminal queued request, including entries behind live work. */
static void terminalize_queue(jdv_transport_state *state)
{
    size_t original;
    size_t kept = 0;
    size_t bytes = 0;
    size_t i;
    if (!state || !state->connected) return;
    original = state->queue_count;
    for (i = 0; i < original; ++i) {
        size_t source = (state->queue_head + i) % state->queue_capacity;
        size_t destination = (state->queue_head + kept) % state->queue_capacity;
        jdv_request *request = &state->queue[source];
        int expired = request->has_deadline &&
            wall_time_seconds() >= request->deadline;
        if (request->cancelled || expired) {
            const char *code = request->cancelled ? "cancelled" : "expired";
            const char *message = request->cancelled ?
                "The request was cancelled before execution." :
                "The request expired before execution.";
            char id_json[JDV_ID_JSON_CAPACITY];
            memcpy(id_json, request->id_json, sizeof(id_json));
            free(request->json);
            memset(request, 0, sizeof(*request));
            if (state->connected && !send_error(state, id_json, code, message))
                return;
            continue;
        }
        if (destination != source) {
            state->queue[destination] = *request;
            memset(request, 0, sizeof(*request));
        }
        bytes += state->queue[destination].length;
        kept++;
    }
    state->queue_count = kept;
    state->queue_bytes = bytes;
}

static SEXP gate_body(void *data)
{
    jdv_gate *gate = (jdv_gate *)data;
    int error = 0;
    SEXP value = R_tryEval(gate->state->frame_call, R_BaseEnv, &error);
    if (!error && TYPEOF(value) == INTSXP && XLENGTH(value) == 1 &&
        INTEGER(value)[0] != NA_INTEGER && INTEGER(value)[0] >= 0) {
        gate->nframe = INTEGER(value)[0];
        gate->valid = 1;
    }
    return R_NilValue;
}

static void restore_gate(void *data, Rboolean jump)
{
    jdv_gate *gate = (jdv_gate *)data;
    (void)jump;
    R_interrupts_suspended = gate->previous_suspend;
}

static void gate_boundary(void *data)
{
    jdv_gate *gate = (jdv_gate *)data;
    SEXP continuation = PROTECT(R_MakeUnwindCont());
    gate->previous_suspend = R_interrupts_suspended;
    R_interrupts_suspended = TRUE;
    (void)R_UnwindProtect(gate_body, gate, restore_gate, gate, continuation);
    UNPROTECT(1);
}

static int gate_allows(jdv_transport_state *state)
{
    jdv_gate gate;
    Rboolean ok;
    if (!state || state->busy || dispatch_depth || gate_depth) return 0;
    gate.state = state;
    gate.previous_suspend = R_interrupts_suspended;
    gate.nframe = -1;
    gate.valid = 0;
    gate_depth++;
    /* This independent gate uses public evaluation and unwind APIs; it does
       not copy R or later implementation code. */
    ok = R_ToplevelExec(gate_boundary, &gate);
    gate_depth--;
    if (!ok || !gate.valid || gate.nframe != 0) return 0;
    return 1;
}

static SEXP callback_body(void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    SEXP text = PROTECT(Rf_mkCharLenCE(dispatch->request.json,
                                      (int)dispatch->request.length, CE_UTF8));
    SEXP argument = PROTECT(Rf_ScalarString(text));
    SEXP call = PROTECT(Rf_lang2(dispatch->state->request_callback, argument));
    SEXP result = Rf_eval(call, R_GlobalEnv);
    UNPROTECT(3);
    return result;
}

static SEXP callback_condition(SEXP condition, void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    dispatch->failure = Rf_inherits(condition, "interrupt") ?
        JDV_FAILURE_INTERRUPTED : JDV_FAILURE_R_ERROR;
    return R_NilValue;
}

static SEXP callback_with_conditions(void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    SEXP classes = PROTECT(Rf_allocVector(STRSXP, 2));
    SEXP result;
    SET_STRING_ELT(classes, 0, Rf_mkChar("interrupt"));
    SET_STRING_ELT(classes, 1, Rf_mkChar("error"));
    result = R_tryCatch(callback_body, dispatch, classes,
                        callback_condition, dispatch, NULL, NULL);
    UNPROTECT(1);
    return result;
}

static void release_dispatch(void *data, Rboolean jump)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    jdv_transport_state *state = dispatch->state;
    if (jump && dispatch->request.json) {
        free(dispatch->request.json);
        dispatch->request.json = NULL;
        if (dispatch->request_source)
            dispatch->request_source->json = NULL;
    }
    if (state) state->busy = 0;
    if (state && state->closing) {
        state->pending_close = 1;
    }
}

static SEXP dispatch_unwind(void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    SEXP result = R_UnwindProtect(callback_with_conditions, dispatch,
                                  release_dispatch, dispatch,
                                  dispatch->callback_continuation);
    return result;
}

static void dispatch_top_level(void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    dispatch->response = dispatch_unwind(dispatch);
    PROTECT(dispatch->response);
    if (TYPEOF(dispatch->response) == STRSXP &&
        XLENGTH(dispatch->response) == 1 &&
        STRING_ELT(dispatch->response, 0) != NA_STRING) {
        R_PreserveObject(dispatch->response);
        dispatch->response_is_string = 1;
    }
    UNPROTECT(1);
}

static SEXP dispatch_frame_body(void *data)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    jdv_transport_state *state = dispatch->state;
    Rboolean ok = TRUE;
    if (dispatch->background)
        ok = R_ToplevelExec(dispatch_top_level, dispatch);
    else
        dispatch_top_level(dispatch);
    if (!ok && dispatch->failure == JDV_FAILURE_NONE)
        dispatch->failure = JDV_FAILURE_UNKNOWN;

    if (active_state == state && state->connected && !state->closing) {
        if (dispatch->failure == JDV_FAILURE_INTERRUPTED) {
            send_error(state, dispatch->request.id_json, "interrupted",
                       "The request was interrupted.");
        } else if (dispatch->failure == JDV_FAILURE_R_ERROR ||
                   dispatch->failure == JDV_FAILURE_UNKNOWN) {
            send_error(state, dispatch->request.id_json, "r_error",
                       "The request could not be processed.");
        } else if (dispatch->response_is_string) {
            SEXP string = STRING_ELT(dispatch->response, 0);
            const char *response = CHAR(string);
            size_t length = (size_t)LENGTH(string);
            if (length > state->max_message_bytes ||
                !jdv_json_validate_output((const unsigned char *)response,
                                          length,
                                          state->max_message_bytes) ||
                !send_message(state, response, length)) {
                stop_connection(state, 1);
            }
        }
    }
    return R_NilValue;
}

static void release_dispatch_frame(void *data, Rboolean jump)
{
    jdv_dispatch *dispatch = (jdv_dispatch *)data;
    jdv_transport_state *state = dispatch->state;
    (void)jump;
    if (dispatch->response_is_string) {
        R_ReleaseObject(dispatch->response);
        dispatch->response_is_string = 0;
    }
    if (dispatch->request.json) {
        free(dispatch->request.json);
        dispatch->request.json = NULL;
        if (dispatch->request_source)
            dispatch->request_source->json = NULL;
    }
    if (dispatch->request_source)
        memset(dispatch->request_source, 0, sizeof(*dispatch->request_source));
    if (state) {
        state->busy = 0;
        if (state->closing) state->pending_close = 1;
    }
    if (dispatch_depth > 0) dispatch_depth--;
}

static int dispatch_request(jdv_transport_state *state, jdv_request *request,
                            int background)
{
    jdv_dispatch dispatch;
    SEXP callback_continuation = PROTECT(R_MakeUnwindCont());
    SEXP frame_continuation = PROTECT(R_MakeUnwindCont());
    if (state != active_state || !state->connected || state->closing) {
        UNPROTECT(2);
        return 0;
    }
    memset(&dispatch, 0, sizeof(dispatch));
    dispatch.state = state;
    dispatch.request = *request;
    dispatch.request_source = request;
    dispatch.callback_continuation = callback_continuation;
    dispatch.frame_continuation = frame_continuation;
    dispatch.background = background;
    dispatch.failure = JDV_FAILURE_NONE;
    state->busy = 1;
    dispatch_depth++;
    (void)R_UnwindProtect(dispatch_frame_body, &dispatch,
                          release_dispatch_frame, &dispatch,
                          dispatch.frame_continuation);
    UNPROTECT(2);
    return dispatch.failure == JDV_FAILURE_NONE;
}

typedef struct {
    jdv_transport_state *state;
    int allow_gate;
    size_t drain_budget;
    jdv_request current_request;
    int owns_request;
} jdv_drain_call;

static SEXP service_queue_body(void *data)
{
    jdv_drain_call *call = (jdv_drain_call *)data;
    jdv_transport_state *state = call->state;
    int allow_gate = call->allow_gate;
    size_t drain_budget = call->drain_budget;
    size_t drained = 0;
    if (!state || state->closing)
        return R_NilValue;
    terminalize_queue(state);
    if (state->busy || dispatch_depth)
        return R_NilValue;
    while (state->queue_count && drained < drain_budget && state->connected) {
        jdv_request *front = &state->queue[state->queue_head];
        jdv_request *request = &call->current_request;
        if (front->cancelled) {
            queue_pop(state, request);
            call->owns_request = 1;
            (void)send_error(state, request->id_json, "cancelled",
                             "The request was cancelled before execution.");
            free(request->json);
            memset(request, 0, sizeof(*request));
            call->owns_request = 0;
            drained++;
            continue;
        }
        if (front->has_deadline && wall_time_seconds() >= front->deadline) {
            queue_pop(state, request);
            call->owns_request = 1;
            (void)send_error(state, request->id_json, "expired",
                             "The request expired before execution.");
            free(request->json);
            memset(request, 0, sizeof(*request));
            call->owns_request = 0;
            drained++;
            continue;
        }
        if (allow_gate && !gate_allows(state)) break;
        if (state != active_state || !state->connected || state->closing ||
            state->busy || state->queue_count == 0) break;
        front = &state->queue[state->queue_head];
        if (front->cancelled ||
            (front->has_deadline &&
             wall_time_seconds() >= front->deadline)) {
            queue_pop(state, request);
            call->owns_request = 1;
            (void)send_error(state, request->id_json,
                             request->cancelled ? "cancelled" : "expired",
                             request->cancelled ?
                               "The request was cancelled before execution." :
                               "The request expired before execution.");
            free(request->json);
            memset(request, 0, sizeof(*request));
            call->owns_request = 0;
            drained++;
            continue;
        }
        queue_pop(state, request);
        call->owns_request = 1;
        drained++;
        (void)dispatch_request(state, request, allow_gate);
        if (request->json) {
            free(request->json);
            request->json = NULL;
        }
        memset(request, 0, sizeof(*request));
        call->owns_request = 0;
        if (active_state != state || !state->connected || state->closing) break;
    }
    return R_NilValue;
}

static void release_service_queue(void *data)
{
    jdv_drain_call *call = (jdv_drain_call *)data;
    if (call->owns_request && call->current_request.json) {
        free(call->current_request.json);
        call->current_request.json = NULL;
    }
    call->owns_request = 0;
    if (drain_depth > 0) drain_depth--;
}

static void service_queue(jdv_transport_state *state, int allow_gate,
                          size_t drain_budget)
{
    jdv_drain_call call;
    if (drain_depth || !state) return;
    call.state = state;
    call.allow_gate = allow_gate;
    call.drain_budget = drain_budget;
    memset(&call.current_request, 0, sizeof(call.current_request));
    call.owns_request = 0;
    drain_depth++;
    (void)R_ExecWithCleanup(service_queue_body, &call,
                            release_service_queue, &call);
}

typedef struct {
    jdv_transport_state *state;
    int allow_gate;
    size_t receive_budget;
    size_t drain_budget;
    uint64_t ack_frames;
} jdv_service_call;

static SEXP service_state_body(void *data)
{
    jdv_service_call *call = (jdv_service_call *)data;
    jdv_transport_state *state = call->state;
    if (state == active_state && !state->closing) {
        state->last_receive_bytes = receive_socket(state, call->receive_budget);
        call->ack_frames = state->total_receive_frames;
        if (state == active_state && state->connected) {
            terminalize_queue(state);
            service_queue(state, call->allow_gate, call->drain_budget);
        }
        if (state == active_state && state->connected && !state->closing &&
            call->ack_frames > state->last_ack_frames)
            (void)send_ack(state, call->ack_frames);
    }
    return R_NilValue;
}

static void release_service(void *data)
{
    jdv_service_call *call = (jdv_service_call *)data;
    state_release(call->state);
}

static void service_state(jdv_transport_state *state, int allow_gate,
                          size_t receive_budget, size_t drain_budget)
{
    jdv_service_call call;
    if (!state || state != active_state || state->closing) return;
    call.state = state;
    call.allow_gate = allow_gate;
    call.receive_budget = receive_budget;
    call.drain_budget = drain_budget;
    call.ack_frames = 0;
    state_hold(state);
    (void)R_ExecWithCleanup(service_state_body, &call,
                            release_service, &call);
}

void jdv_transport_on_readable(void)
{
    jdv_transport_state *state = active_state;
    if (!state || !state->connected) return;
    service_state(state, 1, state->max_receive_bytes,
                  state->max_drain_requests);
}

void jdv_transport_on_timer(void)
{
    jdv_transport_state *state = active_state;
    if (!state || !state->connected) return;
    service_state(state, 1, state->max_receive_bytes,
                  state->max_drain_requests);
}

static void initialize_state(jdv_transport_state *state)
{
    state->socket = JDV_INVALID_SOCKET;
    state->request_callback = R_NilValue;
    state->disconnect_callback = R_NilValue;
    state->frame_call = R_NilValue;
#ifdef _WIN32
    state->pipe = INVALID_HANDLE_VALUE;
#endif
}

static void fail_new_connection(jdv_transport_state *state)
{
    if (!state) return;
    if (retiring_state == state) retiring_state = NULL;
    state->pending_disconnect = 0;
    state->closing = 1;
    free_state(state);
}

typedef struct {
    SEXP address;
    SEXP request_callback;
    SEXP disconnect_callback;
    SEXP limits;
    jdv_transport_state *state;
    int construction_active;
    int committed;
} jdv_connect_call;

static SEXP connect_body(void *data)
{
    jdv_connect_call *call = (jdv_connect_call *)data;
    SEXP address = call->address;
    SEXP request_callback = call->request_callback;
    SEXP disconnect_callback = call->disconnect_callback;
    SEXP limits = call->limits;
    jdv_transport_state *state;
    const char *endpoint;
    size_t max_queue_messages;
    size_t max_queue_bytes;
    size_t max_request_bytes;
    size_t max_message_bytes;
    size_t max_receive_bytes;
    size_t max_drain_requests;
    size_t send_timeout_ms;
    if (construction_depth == 0) construction_cancelled = 0;
    construction_depth++;
    call->construction_active = 1;
    if (TYPEOF(address) != STRSXP || XLENGTH(address) != 1 ||
        STRING_ELT(address, 0) == NA_STRING)
        Rf_error("Transport address must be one nonmissing string.");
    if (!Rf_isFunction(request_callback) || !Rf_isFunction(disconnect_callback))
        Rf_error("Transport callbacks must be functions.");
    if (active_state || retiring_state || dispatch_depth || gate_depth ||
        drain_depth ||
        housekeeping_depth ||
        reclamation_depth || construction_depth > 1)
        Rf_error("A transport connection or cleanup is already active.");
    if (next_epoch > UINT64_C(9007199254740991))
        Rf_error("The transport connection epoch is exhausted.");
    if (!checked_limit(limits, "queue_messages", JDV_DEFAULT_QUEUE_MESSAGES,
                       1, 65536, &max_queue_messages) ||
        !checked_limit(limits, "queue_bytes", JDV_DEFAULT_QUEUE_BYTES,
                       1024, 1073741824u, &max_queue_bytes) ||
        !checked_limit(limits, "max_request_bytes", JDV_DEFAULT_REQUEST_BYTES,
                       128, 67108864u, &max_request_bytes) ||
        !checked_limit(limits, "max_message_bytes", JDV_DEFAULT_MESSAGE_BYTES,
                       1024, 1073741824u, &max_message_bytes) ||
        !checked_limit(limits, "max_receive_bytes",
                       max_request_bytes + 1 > JDV_DEFAULT_RECEIVE_MIN ?
                           max_request_bytes + 1 : JDV_DEFAULT_RECEIVE_MIN,
                       JDV_DEFAULT_RECEIVE_MIN, 1073741824u,
                       &max_receive_bytes) ||
        !checked_limit(limits, "max_drain_requests",
                       JDV_DEFAULT_DRAIN_REQUESTS, 1, 4096,
                       &max_drain_requests) ||
        !checked_limit(limits, "send_timeout_ms",
                       JDV_DEFAULT_SEND_TIMEOUT_MS, 1, 60000,
                       &send_timeout_ms))
        Rf_error("Invalid transport limits.");
    if (max_receive_bytes < max_request_bytes + 1)
        max_receive_bytes = max_request_bytes + 1;
    endpoint = CHAR(STRING_ELT(address, 0));
    if (!endpoint[0]) Rf_error("Transport address cannot be empty.");

    state = (jdv_transport_state *)calloc(1, sizeof(*state));
    if (!state) Rf_error("Unable to allocate transport state.");
    call->state = state;
    initialize_state(state);
    state_hold(state);
    state->epoch = next_epoch++;
    state->max_queue_messages = max_queue_messages;
    state->max_queue_bytes = max_queue_bytes;
    state->max_request_bytes = max_request_bytes;
    state->max_message_bytes = max_message_bytes;
    state->max_receive_bytes = max_receive_bytes;
    state->max_drain_requests = max_drain_requests;
    state->send_timeout_ms = (unsigned int)send_timeout_ms;
    state->read_capacity = max_request_bytes + 1;
    state->queue_capacity = max_queue_messages;
    state->read_buffer = (char *)malloc(state->read_capacity);
    state->queue = (jdv_request *)calloc(state->queue_capacity,
                                         sizeof(jdv_request));
    if (!state->read_buffer || !state->queue) {
        free_state(state);
        Rf_error("Unable to allocate bounded transport buffers.");
    }
    state->request_callback = request_callback;
    state->disconnect_callback = disconnect_callback;
    state->frame_call = PROTECT(Rf_lang1(Rf_install("sys.nframe")));
    R_PreserveObject(state->request_callback);
    R_PreserveObject(state->disconnect_callback);
    R_PreserveObject(state->frame_call);
    UNPROTECT(1);
    SEXP result = PROTECT(Rf_ScalarLogical(1));
    if (construction_cancelled) {
        UNPROTECT(1);
        Rf_error("The transport connection was cancelled during setup.");
    }
    if (!connect_endpoint(state, endpoint)) {
        UNPROTECT(1);
        fail_new_connection(state);
        Rf_error("Unable to connect to the configured jdv endpoint.");
    }
#ifndef _WIN32
    if (state->socket < 0 || state->socket >= FD_SETSIZE) {
        UNPROTECT(1);
        fail_new_connection(state);
        Rf_error("The jdv endpoint uses a file descriptor outside FD_SETSIZE.");
    }
#endif
    if (construction_cancelled) {
        UNPROTECT(1);
        fail_new_connection(state);
        Rf_error("The transport connection was cancelled during setup.");
    }
    active_state = state;
    jdv_loop_start((uintptr_t)state->socket);
    state->source_active = jdv_loop_source_active();
    if (!state->source_active) {
        active_state = NULL;
        stop_connection(state, 0);
        fail_new_connection(state);
        UNPROTECT(1);
        Rf_error("Unable to register the jdv event source.");
    }
    call->committed = 1;
    UNPROTECT(1);
    return result;
}

static void release_connect(void *data)
{
    jdv_connect_call *call = (jdv_connect_call *)data;
    jdv_transport_state *state = call->state;
    if (state && !call->committed) {
        if (active_state == state) active_state = NULL;
        if (retiring_state == state) retiring_state = NULL;
        stop_connection(state, 0);
        state->pending_disconnect = 0;
        free_state(state);
    }
    if (state) state_release(state);
    if (call->construction_active) {
        construction_depth--;
        call->construction_active = 0;
        if (construction_depth == 0) construction_cancelled = 0;
    }
}

static SEXP connect_body_entry(void *data)
{
    return R_ExecWithCleanup(connect_body, data, release_connect, data);
}

SEXP C_jdv_transport_connect(SEXP address, SEXP request_callback,
                             SEXP disconnect_callback, SEXP limits)
{
    jdv_connect_call call;
    memset(&call, 0, sizeof(call));
    call.address = address;
    call.request_callback = request_callback;
    call.disconnect_callback = disconnect_callback;
    call.limits = limits;
    return with_native_entry(connect_body_entry, &call);
}

typedef struct {
    jdv_transport_state *state;
    SEXP messages;
    int owns_hold;
    int owns_send;
} jdv_send_call;

static SEXP send_messages_body(void *data)
{
    jdv_send_call *call = (jdv_send_call *)data;
    jdv_transport_state *state = call->state;
    SEXP messages = call->messages;
    R_xlen_t i;
    if (TYPEOF(messages) != STRSXP)
        Rf_error("Transport messages must be character strings.");
    for (i = 0; i < XLENGTH(messages); ++i) {
        SEXP value = STRING_ELT(messages, i);
        const char *text;
        size_t length;
        double remaining;
        double deadline;
        if (value == NA_STRING) Rf_error("Transport message cannot be NA.");
        text = CHAR(value);
        length = (size_t)LENGTH(value);
        if (length > state->max_message_bytes ||
            memchr(text, '\0', length) != NULL ||
            !jdv_json_validate_output((const unsigned char *)text, length,
                                      state->max_message_bytes))
            Rf_error("Transport message is invalid or exceeds its byte limit.");
        deadline = monotonic_seconds() +
            (double)state->send_timeout_ms / 1000.0;
        remaining = deadline - monotonic_seconds();
        if (remaining <= 0) {
            stop_connection(state, 1);
            Rf_error("Timed out while sending a jdv message.");
        }
        if (!send_bytes_until(state, text, length, deadline) ||
            !send_bytes_until(state, "\n", 1, deadline)) {
            stop_connection(state, 1);
            Rf_error("Failed to send a jdv message.");
        }
        if (state != active_state || !state->connected)
            Rf_error("The jdv transport disconnected while sending.");
    }
    return Rf_ScalarLogical(1);
}

static void release_send(void *data)
{
    jdv_send_call *call = (jdv_send_call *)data;
    if (call->state) {
        if (call->owns_send) call->state->sending = 0;
        if (call->owns_hold) state_release(call->state);
    }
}

static SEXP send_entry_body(void *data)
{
    jdv_send_call *call = (jdv_send_call *)data;
    call->state = active_state;
    if (!call->state || !call->state->connected || call->state->closing)
        Rf_error("The jdv transport is not connected.");
    state_hold(call->state);
    call->owns_hold = 1;
    if (call->state->sending)
        Rf_error("A jdv transport send is already in progress.");
    call->state->sending = 1;
    call->owns_send = 1;
    return send_messages_body(call);
}

static SEXP send_entry_body_with_cleanup(void *data)
{
    return R_ExecWithCleanup(send_entry_body, data, release_send, data);
}

SEXP C_jdv_transport_send(SEXP messages)
{
    jdv_send_call call;
    call.state = NULL;
    call.messages = messages;
    call.owns_hold = 0;
    call.owns_send = 0;
    return with_native_entry(send_entry_body_with_cleanup, &call);
}

SEXP C_jdv_transport_poll(void)
{
    jdv_transport_state *state = active_state;
    if (!state || !state->connected) {
        if (retiring_state && !dispatch_depth && !gate_depth)
            (void)run_disconnect_callback(retiring_state);
        return R_NilValue;
    }
    if (state->busy || dispatch_depth || gate_depth || drain_depth)
        return R_NilValue;
    service_state(state, 0, state->max_receive_bytes,
                  state->max_drain_requests);
    return R_NilValue;
}

SEXP C_jdv_transport_close(void)
{
    jdv_transport_state *state = active_state;
    if (!state) {
        if (construction_depth > 0) construction_cancelled = 1;
        return status_for(retiring_state);
    }
    stop_connection(state, 1);
    state->pending_close = 1;
    if (!state->busy && !dispatch_depth)
        (void)run_disconnect_callback(state);
    return status_for(retiring_state);
}

SEXP C_jdv_transport_status(void)
{
    return status_for(active_state ? active_state : retiring_state);
}

SEXP C_jdv_transport_housekeeping(void)
{
    jdv_transport_state *state = retiring_state;
    int complete = 1;
    if (state && state->pending_disconnect) {
        complete = run_disconnect_callback(state);
    }
    return Rf_ScalarLogical(complete);
}

SEXP C_jdv_transport_can_unload(void)
{
    int allowed = jdv_module_depth() == 1 && !dispatch_depth && !gate_depth &&
        !drain_depth && !housekeeping_depth &&
        !construction_depth && !reclamation_depth &&
        !active_state && !retiring_state;
    return Rf_ScalarLogical(allowed);
}

void jdv_transport_unload(void)
{
    if (jdv_module_depth() != 0 || dispatch_depth || gate_depth || drain_depth ||
        housekeeping_depth || construction_depth ||
        reclamation_depth ||
        (active_state && (active_state->busy || active_state->holds)) ||
        (retiring_state && (retiring_state->busy || retiring_state->holds))) {
        Rf_error("Cannot unload jdv while transport dispatch is active.");
    }
    if (active_state) {
        jdv_transport_state *state = active_state;
        active_state = NULL;
        stop_connection(state, 0);
        free_state(state);
    }
    if (retiring_state) {
        jdv_transport_state *state = retiring_state;
        retiring_state = NULL;
        state->pending_disconnect = 0;
        free_state(state);
    }
#ifdef _WIN32
    if (winsock_started) {
        WSACleanup();
        winsock_started = 0;
    }
#endif
}
