#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif
#endif

#include "transport.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Utils.h>

typedef SEXP (*jdv_loop_event_fn)(void *);

typedef struct {
    jdv_loop_event_fn body;
    void *data;
} jdv_loop_event;

static SEXP loop_event_body(void *data)
{
    jdv_loop_event *event = (jdv_loop_event *)data;
    return event->body(event->data);
}

static void release_loop_event(void *data)
{
    (void)data;
    jdv_module_leave();
}

static void run_loop_event(jdv_loop_event_fn body, void *data)
{
    jdv_loop_event event;
    event.body = body;
    event.data = data;
    jdv_module_enter();
    (void)R_ExecWithCleanup(loop_event_body, &event,
                            release_loop_event, &event);
}

#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>

static const char window_class_name[] = "jdv_transport_message_window";
static HWND loop_window = NULL;
static ATOM loop_class = 0;
static HINSTANCE loop_instance = NULL;
static const UINT_PTR loop_timer_id = 1;
#define JDV_TIMER_INTERVAL_MS 200
#define JDV_READABLE_MESSAGE (WM_APP + 1)
#define JDV_SOCKET_WAIT_MS 50
#define JDV_PIPE_POLL_MS 10
static HANDLE monitor_stop_event = NULL;
static HANDLE monitor_thread = NULL;
static SOCKET monitor_socket = INVALID_SOCKET;
static HANDLE monitor_pipe = INVALID_HANDLE_VALUE;
static volatile LONG readable_message_pending = 0;

static SEXP timer_event(void *data)
{
    (void)data;
    if (jdv_transport_loop_fd() != -2) jdv_transport_on_timer();
    return R_NilValue;
}

static void post_readable_message(void)
{
    if (InterlockedCompareExchange(&readable_message_pending, 1, 0) == 0 &&
        !PostMessageA(loop_window, JDV_READABLE_MESSAGE, 0, 0)) {
        InterlockedExchange(&readable_message_pending, 0);
    }
}

static DWORD WINAPI monitor_readable_sources(void *data)
{
    (void)data;
    /* The worker only observes native handles and posts to the R-owned window. */
    for (;;) {
        if (WaitForSingleObject(monitor_stop_event, 0) != WAIT_TIMEOUT) break;
        int readable = 0;
        if (monitor_socket != INVALID_SOCKET) {
            WSAPOLLFD descriptor;
            int result;
            descriptor.fd = monitor_socket;
            descriptor.events = POLLRDNORM;
            descriptor.revents = 0;
            result = WSAPoll(&descriptor, 1, JDV_SOCKET_WAIT_MS);
            if (result == SOCKET_ERROR ||
                (result > 0 && descriptor.revents != 0)) {
                readable = 1;
            }
        } else if (monitor_pipe != INVALID_HANDLE_VALUE && monitor_pipe != NULL) {
            DWORD wait_result = WaitForSingleObject(monitor_stop_event,
                                                    JDV_PIPE_POLL_MS);
            if (wait_result != WAIT_TIMEOUT) break;
            DWORD available = 0;
            if (!PeekNamedPipe(monitor_pipe, NULL, 0, NULL, &available, NULL) ||
                available > 0) {
                readable = 1;
            }
        } else {
            break;
        }

        if (readable) {
            post_readable_message();
            /* Avoid spinning on level-triggered readiness while the main thread runs. */
            if (WaitForSingleObject(monitor_stop_event,
                                    JDV_PIPE_POLL_MS) != WAIT_TIMEOUT) {
                break;
            }
        }
    }
    return 0;
}

static void stop_readable_monitor(void)
{
    if (monitor_stop_event) SetEvent(monitor_stop_event);
    if (monitor_thread) {
        WaitForSingleObject(monitor_thread, INFINITE);
        CloseHandle(monitor_thread);
        monitor_thread = NULL;
    }
    if (monitor_stop_event) {
        CloseHandle(monitor_stop_event);
        monitor_stop_event = NULL;
    }
    monitor_socket = INVALID_SOCKET;
    monitor_pipe = INVALID_HANDLE_VALUE;
    InterlockedExchange(&readable_message_pending, 0);
}

static void start_readable_monitor(uintptr_t fd, uintptr_t pipe_handle)
{
    monitor_socket = (SOCKET)fd;
    monitor_pipe = (HANDLE)pipe_handle;
    if (monitor_socket == INVALID_SOCKET &&
        (monitor_pipe == INVALID_HANDLE_VALUE || monitor_pipe == NULL)) return;
    monitor_stop_event = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!monitor_stop_event) goto fail;
    monitor_thread = CreateThread(NULL, 0, monitor_readable_sources, NULL, 0,
                                  NULL);
    if (!monitor_thread) goto fail;
    return;

fail:
    stop_readable_monitor();
}

static LRESULT CALLBACK jdv_window_proc(HWND window, UINT message,
                                        WPARAM wparam, LPARAM lparam)
{
    (void)lparam;
    if (message == WM_TIMER && wparam == loop_timer_id) {
        run_loop_event(timer_event, NULL);
        return 0;
    }
    if (message == JDV_READABLE_MESSAGE) {
        InterlockedExchange(&readable_message_pending, 0);
        run_loop_event(timer_event, NULL);
        return 0;
    }
    return DefWindowProcA(window, message, wparam, lparam);
}

void jdv_loop_start(uintptr_t fd, uintptr_t pipe_handle)
{
    if (loop_window) return;
    if (!loop_class) {
        WNDCLASSEXA cls;
        if (!GetModuleHandleExA(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                (LPCSTR)(const void *)&loop_class, &loop_instance)) return;
        ZeroMemory(&cls, sizeof(cls));
        cls.cbSize = sizeof(cls);
        cls.lpfnWndProc = jdv_window_proc;
        cls.hInstance = loop_instance;
        cls.lpszClassName = window_class_name;
        loop_class = RegisterClassExA(&cls);
    }
    if (!loop_class) {
        loop_instance = NULL;
        return;
    }
    loop_window = CreateWindowExA(0, window_class_name, "jdv", 0,
                                  0, 0, 0, 0, HWND_MESSAGE, NULL,
                                  loop_instance, NULL);
    if (!loop_window) {
        UnregisterClassA(window_class_name, loop_instance);
        loop_class = 0;
        loop_instance = NULL;
        return;
    }
    if (!SetTimer(loop_window, loop_timer_id, JDV_TIMER_INTERVAL_MS, NULL)) {
        DestroyWindow(loop_window);
        loop_window = NULL;
        UnregisterClassA(window_class_name, loop_instance);
        loop_class = 0;
        loop_instance = NULL;
        return;
    }
    start_readable_monitor(fd, pipe_handle);
    if (!monitor_thread) jdv_loop_stop();
}

void jdv_loop_stop(void)
{
    MSG message;
    if (!loop_window) return;
    KillTimer(loop_window, loop_timer_id);
    stop_readable_monitor();
    while (PeekMessageA(&message, loop_window, JDV_READABLE_MESSAGE,
                        JDV_READABLE_MESSAGE, PM_REMOVE)) {
    }
    DestroyWindow(loop_window);
    loop_window = NULL;
    UnregisterClassA(window_class_name, loop_instance);
    loop_class = 0;
    loop_instance = NULL;
}

int jdv_loop_source_active(void)
{
    return loop_window != NULL;
}

void jdv_transport_mark_source_stopped(void)
{
    jdv_loop_stop();
}

#else
#include <R_ext/eventloop.h>
#include <sys/select.h>

static InputHandler *loop_handler = NULL;
static int loop_fd = -1;

static SEXP readable_event(void *data)
{
    (void)data;
    jdv_transport_on_readable();
    return R_NilValue;
}

static void jdv_input_handler(void *data)
{
    (void)data;
    run_loop_event(readable_event, NULL);
}

void jdv_loop_start(uintptr_t fd, uintptr_t pipe_handle)
{
    int socket_fd = (int)fd;
    (void)pipe_handle;
    if (loop_handler || socket_fd < 0 || socket_fd >= FD_SETSIZE) return;
    loop_handler = addInputHandler(R_InputHandlers, socket_fd, jdv_input_handler,
                                   XActivity);
    if (loop_handler) loop_fd = socket_fd;
}

void jdv_loop_stop(void)
{
    InputHandler *handler = loop_handler;
    loop_handler = NULL;
    loop_fd = -1;
    if (handler) removeInputHandler(&R_InputHandlers, handler);
}

int jdv_loop_source_active(void)
{
    return loop_handler != NULL;
}

void jdv_transport_mark_source_stopped(void)
{
    jdv_loop_stop();
}

#endif

int jdv_transport_loop_fd(void)
{
#ifdef _WIN32
    /* -2 means no transport source is active. */
    return jdv_loop_source_active() ? -1 : -2;
#else
    return loop_fd;
#endif
}
