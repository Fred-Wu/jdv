/* Isolated event-loop experiment; never link this file into the package. */
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <R_ext/GraphicsEngine.h>
#include <R_ext/GraphicsDevice.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/select.h>
#ifndef HAVE_SYS_SELECT_H
#define HAVE_SYS_SELECT_H 1
#endif
#include <R_ext/eventloop.h>
#endif

#define QUEUE_CAPACITY 256
#define RECEIVE_BUDGET 64
#define DRAIN_BUDGET 8
#define NUDGE_BYTE ((unsigned char)'~')

typedef struct {
    int configured, source_active, busy, closing, background, gated;
    int events, executed, failed, reentrant, dropped, eof, cleanups;
    int max_receive_bytes, max_drain_requests;
    int nudges, gate_checks, gate_deferred, gate_failures, gate_pair_mismatch;
    int bare_nframe, wrapped_nframe, max_nframe, gate_pause_ms, gate_fault;
    unsigned char queue[QUEUE_CAPACITY];
    int head, count;
    unsigned char current;
    SEXP callback, frame_call;
#ifdef _WIN32
    HWND window;
    ATOM window_class;
    unsigned char timer_code;
#else
    int fd;
    InputHandler *handler;
#endif
} SpikeState;

static SpikeState state;
static const char *window_class_name = "jdv_event_spike_window";
static void finish_stop(void);
static void drain_background(void);

static void enqueue(unsigned char code)
{
    if (code == NUDGE_BYTE) {
        state.nudges++;
        fprintf(stderr, "SPIKE_NATIVE|NUDGE\n");
        fflush(stderr);
        return;
    }
    if (state.count == QUEUE_CAPACITY) {
        state.dropped++;
        fprintf(stderr, "SPIKE_NATIVE|DROPPED|%c\n", code);
        fflush(stderr);
        return;
    }
    state.queue[(state.head + state.count) % QUEUE_CAPACITY] = code;
    state.count++;
    fprintf(stderr, "SPIKE_NATIVE|RECEIVED|%c\n", code);
    fflush(stderr);
}

static unsigned char dequeue(void)
{
    unsigned char result = state.queue[state.head];
    state.head = (state.head + 1) % QUEUE_CAPACITY;
    state.count--;
    return result;
}

/* All R allocation/evaluation happens in an explicit drain or this wrapper. */
static SEXP run_callback(void *data)
{
    char code[2] = {(char) state.current, '\0'};
    SEXP arg = PROTECT(Rf_mkString(code));
    SEXP call = PROTECT(Rf_lang2(state.callback, arg));
    Rf_eval(call, R_GlobalEnv);
    UNPROTECT(2);
    return R_NilValue;
}

static void run_callback_background(void *data)
{
    run_callback(data);
}

static void cleanup_execution(void *data, Rboolean jump)
{
    state.busy = 0;
    state.cleanups++;
    if (jump) state.failed++;
    if (state.closing) finish_stop();
    fprintf(stderr, "SPIKE_NATIVE|COMPLETED|%c|%d\n", state.current, !jump);
    fflush(stderr);
}

typedef struct {
    Rboolean previous_suspend;
    int nframe, valid, fault, pause_ms;
} GateProbe;

/* The unwrapped measurement uses a prebuilt call and R_tryEval's own boundary. */
static int bare_nframe(void)
{
    int error = 0;
    SEXP value = R_tryEval(state.frame_call, R_BaseEnv, &error);
    if (error || TYPEOF(value) != INTSXP || XLENGTH(value) != 1 ||
        INTEGER(value)[0] == NA_INTEGER || INTEGER(value)[0] < 0) return -1;
    return INTEGER(value)[0];
}

/* Based on the gating approach in r-lib/later, src/later.cpp
 * (sys_nframe/at_top_level; reference f1d988deb5e9fd26b3af5adee6da454ae7386f9d).
 * Independently implemented using R public APIs; no code copied from R
 * internals or later. Interrupt macros come from the public R header above.
 */
static SEXP probe_gate(void *data)
{
    GateProbe *probe = (GateProbe *)data;
    BEGIN_SUSPEND_INTERRUPTS {
        if (probe->pause_ms) {
            fprintf(stderr, "SPIKE_NATIVE|GATE_SUSPEND_WAIT\n");
            fflush(stderr);
#ifdef _WIN32
            Sleep((DWORD)probe->pause_ms);
#else
            usleep((useconds_t)probe->pause_ms * 1000);
#endif
        }
        if (probe->fault == 1) Rf_error("Injected error inside suspended gate");
        int error = 0;
        SEXP value = PROTECT(R_tryEval(state.frame_call, R_BaseEnv, &error));
        if (probe->fault == 2) value = PROTECT(Rf_mkString("not an integer"));
        else if (probe->fault == 3) value = PROTECT(Rf_allocVector(INTSXP, 2));
        if (!error && TYPEOF(value) == INTSXP && XLENGTH(value) == 1 &&
            INTEGER(value)[0] != NA_INTEGER && INTEGER(value)[0] >= 0) {
            probe->nframe = INTEGER(value)[0];
            probe->valid = 1;
        }
        UNPROTECT(probe->fault == 2 || probe->fault == 3 ? 2 : 1);
    } END_SUSPEND_INTERRUPTS;
    return R_NilValue;
}

static void cleanup_gate(void *data, Rboolean jump)
{
    GateProbe *probe = (GateProbe *)data;
    /* Restore only the publicly declared suspension flag. Never alter pending. */
    R_interrupts_suspended = probe->previous_suspend;
    if (jump) probe->valid = 0;
}

static void gate_boundary(void *data)
{
    R_UnwindProtect(probe_gate, data, cleanup_gate, data, NULL);
}

static int gate_allows_execution(void)
{
    if (state.busy) return 0;
    state.gate_checks++;
    state.bare_nframe = bare_nframe();
    GateProbe probe = {R_interrupts_suspended, -1, 0, state.gate_fault, state.gate_pause_ms};
    state.gate_fault = 0;
    state.gate_pause_ms = 0;
    Rboolean ok = R_ToplevelExec(gate_boundary, &probe);
    state.wrapped_nframe = ok && probe.valid ? probe.nframe : -1;
    if (state.bare_nframe >= 0 && state.wrapped_nframe >= 0 &&
        state.bare_nframe != state.wrapped_nframe) state.gate_pair_mismatch++;
    if (state.wrapped_nframe > state.max_nframe) state.max_nframe = state.wrapped_nframe;
    fprintf(stderr, "SPIKE_NATIVE|GATE|%d|%d|%d\n",
            state.bare_nframe, state.wrapped_nframe, ok && probe.valid);
    fflush(stderr);
    if (!ok || !probe.valid || state.bare_nframe < 0 ||
        state.bare_nframe != state.wrapped_nframe) state.gate_failures++;
    if (!ok || !probe.valid || state.bare_nframe != 0 || probe.nframe != 0) {
        state.gate_deferred++;
        return 0;
    }
    return 1;
}

static void drain_background(void)
{
    int drained = 0;
    while (drained < DRAIN_BUDGET && state.configured && !state.closing && !state.busy && state.count) {
        if (state.gated && !gate_allows_execution()) break;
        state.current = dequeue();
        drained++;
        if (drained > state.max_drain_requests) state.max_drain_requests = drained;
        state.busy = 1;
        state.executed++;
        Rboolean ok = R_ToplevelExec(run_callback_background, NULL);
        cleanup_execution(NULL, !ok);
        fprintf(stderr, "SPIKE_NATIVE|FINISHED|%c|%d\n", state.current, ok);
        fflush(stderr);
    }
}

#ifdef _WIN32
static LRESULT CALLBACK spike_window_proc(HWND window, UINT msg, WPARAM wp, LPARAM lp)
{
    if (msg == WM_TIMER && wp == 1) {
        KillTimer(window, 1);
        if (!state.configured || state.closing) return 0;
        state.events++;
        if (state.max_receive_bytes < 1) state.max_receive_bytes = 1;
        if (state.busy) state.reentrant++;
        enqueue(state.timer_code);
        if (state.background && !state.busy) drain_background();
        return 0;
    }
    return DefWindowProcA(window, msg, wp, lp);
}

static void stop_source(void)
{
    if (state.window) {
        KillTimer(state.window, 1);
        DestroyWindow(state.window);
        state.window = NULL;
    }
    if (state.window_class) {
        UnregisterClassA(window_class_name, GetModuleHandleA(NULL));
        state.window_class = 0;
    }
    state.source_active = 0;
}
#else
static void stop_source(void)
{
    if (state.handler) {
        removeInputHandler(&R_InputHandlers, state.handler);
        state.handler = NULL;
    }
    if (state.fd >= 0) {
        close(state.fd);
        state.fd = -1;
    }
    state.source_active = 0;
}

/* Queue mode touches only C-owned bytes, counters, and OS resources. */
static void spike_input(void *data)
{
    if (!state.configured || state.closing) return;
    state.events++;
    if (state.busy) state.reentrant++;
    unsigned char bytes[RECEIVE_BUDGET];
    int received = 0;
    while (received < RECEIVE_BUDGET) {
        ssize_t n = read(state.fd, bytes, RECEIVE_BUDGET - received);
        if (n > 0) {
            received += (int)n;
            if (received > state.max_receive_bytes) state.max_receive_bytes = received;
            for (ssize_t i = 0; i < n; i++) enqueue(bytes[i]);
        } else if (n == 0) {
            state.eof++;
            stop_source();
            break;
        } else {
            if (errno == EINTR) continue;
            if (errno != EAGAIN && errno != EWOULDBLOCK) stop_source();
            break;
        }
    }
    if (state.background && !state.busy) drain_background();
}
#endif

static void finish_stop(void)
{
    stop_source();
    state.configured = 0;
    state.closing = 0;
    state.count = 0;
    if (state.frame_call != R_NilValue) {
        R_ReleaseObject(state.frame_call);
        state.frame_call = R_NilValue;
    }
    if (state.callback != R_NilValue) {
        R_ReleaseObject(state.callback);
        state.callback = R_NilValue;
    }
}

static SEXP spike_stop(void)
{
    if (state.busy) {
        state.closing = 1;
        stop_source();
    } else {
        finish_stop();
    }
    return R_NilValue;
}

static SEXP spike_start(SEXP fd, SEXP callback, SEXP mode)
{
    if (state.busy) Rf_error("Restart during method execution is unsupported");
    if (!Rf_isFunction(callback)) Rf_error("callback must be a function");
    finish_stop();
    memset(&state, 0, sizeof(state));
    state.callback = R_NilValue;
    state.frame_call = R_NilValue;
#ifndef _WIN32
    state.fd = Rf_asInteger(fd);
    int flags = state.fd >= 0 ? fcntl(state.fd, F_GETFL) : -1;
    if (state.fd < 0 || state.fd >= FD_SETSIZE || flags < 0 ||
        fcntl(state.fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        state.fd = -1;
        Rf_error("Cannot use input file descriptor");
    }
#endif
    int path = Rf_asInteger(mode);
    state.background = path == 0 || path == 3;
    state.gated = path == 3;
    state.bare_nframe = state.wrapped_nframe = -1;
    state.frame_call = PROTECT(Rf_lang1(Rf_install("sys.nframe")));
    R_PreserveObject(state.frame_call);
    UNPROTECT(1);
    state.callback = callback;
    R_PreserveObject(callback);
    state.configured = 1;
#ifdef _WIN32
    WNDCLASSA cls;
    memset(&cls, 0, sizeof(cls));
    cls.lpfnWndProc = spike_window_proc;
    cls.hInstance = GetModuleHandleA(NULL);
    cls.lpszClassName = window_class_name;
    state.window_class = RegisterClassA(&cls);
    if (!state.window_class) {
        finish_stop();
        Rf_error("Cannot register message window class");
    }
    state.window = CreateWindowExA(0, window_class_name, "", 0, 0, 0, 0, 0,
                                 HWND_MESSAGE, NULL, cls.hInstance, NULL);
    if (!state.window) {
        finish_stop();
        Rf_error("Cannot create message-only window");
    }
#else
    state.handler = addInputHandler(R_InputHandlers, state.fd, spike_input, 42);
    if (!state.handler) {
        finish_stop();
        Rf_error("Cannot register input handler");
    }
#endif
    state.source_active = 1;
    return R_NilValue;
}

/* A synchronous interrupt unwinds normally after cleanup, never via ToplevelExec. */
static SEXP spike_poll(void)
{
    if (state.busy) Rf_error("Recursive poll is unsupported");
    int drained = 0;
    while (drained < DRAIN_BUDGET && state.configured && !state.closing && state.count) {
        state.current = dequeue();
        drained++;
        if (drained > state.max_drain_requests) state.max_drain_requests = drained;
        state.busy = 1;
        state.executed++;
        R_UnwindProtect(run_callback, NULL, cleanup_execution, NULL, NULL);
    }
    return R_NilValue;
}

static SEXP spike_arm(SEXP delay, SEXP code)
{
#ifdef _WIN32
    if (!state.configured || state.closing || !state.window) Rf_error("Spike is closed");
    if (TYPEOF(code) != STRSXP || XLENGTH(code) != 1 || STRING_ELT(code, 0) == NA_STRING)
        Rf_error("code must be one character");
    const char *text = Rf_translateCharUTF8(STRING_ELT(code, 0));
    if (strlen(text) != 1) Rf_error("code must be one byte");
    int ms = Rf_asInteger(delay);
    if (ms < 1) Rf_error("delay must be positive");
    state.timer_code = (unsigned char)text[0];
    if (!SetTimer(state.window, 1, (UINT)ms, NULL)) Rf_error("Cannot set timer");
    return R_NilValue;
#else
    Rf_error("Timers are Windows-only; the POSIX runner sends pipe bytes");
    return R_NilValue;
#endif
}

/* Test-only one-shot hooks for the short gate's abnormal exits. */
static SEXP spike_gate_fault(SEXP pause, SEXP fault)
{
    state.gate_pause_ms = Rf_asInteger(pause);
    state.gate_fault = Rf_asInteger(fault);
    if (state.gate_pause_ms < 0 || state.gate_pause_ms > 1000 ||
        state.gate_fault < 0 || state.gate_fault > 3) Rf_error("Invalid gate fault hook");
    return R_NilValue;
}

static SEXP spike_status(void)
{
    const char *names[] = {"configured", "source_active", "busy", "closing", "pending",
                          "events", "executed", "failed", "reentrant", "dropped", "eof", "cleanups",
                          "max_receive_bytes", "max_drain_requests", "nudges", "gate_checks",
                          "gate_deferred", "gate_failures", "gate_pair_mismatch", "bare_nframe",
                          "wrapped_nframe", "max_nframe", "interrupts_suspended"};
    int values[] = {state.configured, state.source_active, state.busy, state.closing, state.count,
                    state.events, state.executed, state.failed, state.reentrant, state.dropped,
                    state.eof, state.cleanups, state.max_receive_bytes, state.max_drain_requests,
                    state.nudges, state.gate_checks, state.gate_deferred, state.gate_failures,
                    state.gate_pair_mismatch, state.bare_nframe, state.wrapped_nframe,
                    state.max_nframe, R_interrupts_suspended};
    int n = sizeof(values) / sizeof(values[0]);
    SEXP result = PROTECT(Rf_allocVector(INTSXP, n));
    SEXP labels = PROTECT(Rf_allocVector(STRSXP, n));
    for (int i = 0; i < n; i++) {
        INTEGER(result)[i] = values[i];
        SET_STRING_ELT(labels, i, Rf_mkChar(names[i]));
    }
    Rf_setAttrib(result, R_NamesSymbol, labels);
    UNPROTECT(2);
    return result;
}

static const R_CallMethodDef calls[] = {
    {"spike_start", (DL_FUNC) &spike_start, 3},
    {"spike_stop", (DL_FUNC) &spike_stop, 0},
    {"spike_poll", (DL_FUNC) &spike_poll, 0},
    {"spike_arm", (DL_FUNC) &spike_arm, 2},
    {"spike_status", (DL_FUNC) &spike_status, 0},
    {"spike_gate_fault", (DL_FUNC) &spike_gate_fault, 2},
    {NULL, NULL, 0}
};

void R_init_jdv_spike(DllInfo *dll)
{
    memset(&state, 0, sizeof(state));
    state.callback = R_NilValue;
    state.frame_call = R_NilValue;
#ifndef _WIN32
    state.fd = -1;
#endif
    R_registerRoutines(dll, NULL, calls, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
