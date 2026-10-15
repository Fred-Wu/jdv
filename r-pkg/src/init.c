#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>
#include "int64.h"
#include "transport.h"
#include "arrow.h"

static int module_depth = 0;
static int module_unloading = 0;

int jdv_module_depth(void)
{
    return module_depth;
}

void jdv_module_enter(void)
{
    if (module_unloading)
        Rf_error("The jdv native library is being unloaded.");
    module_depth++;
}

void jdv_module_leave(void)
{
    if (module_depth > 0) module_depth--;
}

static void release_module_entry(void *data)
{
    (void)data;
    jdv_module_leave();
}

#define JDV_WRAP_0(entry, target)                                      \
    static SEXP entry##_body(void *data)                               \
    {                                                                  \
        (void)data;                                                    \
        return target();                                               \
    }                                                                  \
    static SEXP entry(void)                                            \
    {                                                                  \
        jdv_module_enter();                                            \
        return R_ExecWithCleanup(entry##_body, NULL,                    \
                                 release_module_entry, NULL);          \
    }

#define JDV_WRAP_1(entry, target)                                      \
    typedef struct { SEXP a; } entry##_args;                           \
    static SEXP entry##_body(void *data)                               \
    {                                                                  \
        entry##_args *args = (entry##_args *)data;                     \
        return target(args->a);                                        \
    }                                                                  \
    static SEXP entry(SEXP a)                                           \
    {                                                                  \
        entry##_args args = {a};                                       \
        jdv_module_enter();                                            \
        return R_ExecWithCleanup(entry##_body, &args,                   \
                                 release_module_entry, &args);         \
    }

#define JDV_WRAP_2(entry, target)                                      \
    typedef struct { SEXP a, b; } entry##_args;                        \
    static SEXP entry##_body(void *data)                               \
    {                                                                  \
        entry##_args *args = (entry##_args *)data;                     \
        return target(args->a, args->b);                               \
    }                                                                  \
    static SEXP entry(SEXP a, SEXP b)                                  \
    {                                                                  \
        entry##_args args = {a, b};                                    \
        jdv_module_enter();                                            \
        return R_ExecWithCleanup(entry##_body, &args,                   \
                                 release_module_entry, &args);         \
    }

#define JDV_WRAP_3(entry, target)                                      \
    typedef struct { SEXP a, b, c; } entry##_args;                     \
    static SEXP entry##_body(void *data)                               \
    {                                                                  \
        entry##_args *args = (entry##_args *)data;                     \
        return target(args->a, args->b, args->c);                      \
    }                                                                  \
    static SEXP entry(SEXP a, SEXP b, SEXP c)                          \
    {                                                                  \
        entry##_args args = {a, b, c};                                 \
        jdv_module_enter();                                            \
        return R_ExecWithCleanup(entry##_body, &args,                   \
                                 release_module_entry, &args);         \
    }

#define JDV_WRAP_4(entry, target)                                      \
    typedef struct { SEXP a, b, c, d; } entry##_args;                  \
    static SEXP entry##_body(void *data)                               \
    {                                                                  \
        entry##_args *args = (entry##_args *)data;                     \
        return target(args->a, args->b, args->c, args->d);             \
    }                                                                  \
    static SEXP entry(SEXP a, SEXP b, SEXP c, SEXP d)                  \
    {                                                                  \
        entry##_args args = {a, b, c, d};                              \
        jdv_module_enter();                                            \
        return R_ExecWithCleanup(entry##_body, &args,                   \
                                 release_module_entry, &args);         \
    }

SEXP C_jdv_json_parse(SEXP input, SEXP max_bytes);
SEXP C_jdv_json_encode(SEXP object, SEXP max_bytes, SEXP max_work_bytes);
SEXP C_jdv_transport_connect(SEXP address, SEXP request_callback,
                             SEXP disconnect_callback, SEXP limits);
SEXP C_jdv_transport_send(SEXP messages);
SEXP C_jdv_transport_poll(void);
SEXP C_jdv_transport_close(void);
SEXP C_jdv_transport_status(void);
SEXP C_jdv_transport_can_unload(void);
SEXP C_jdv_transport_housekeeping(void);
SEXP C_jdv_transport_cleanup(void);
SEXP C_jdv_tree_info(SEXP x);
SEXP C_jdv_tree_child(SEXP x, SEXP kind, SEXP index, SEXP name);
SEXP C_jdv_tree_same(SEXP x, SEXP y);
SEXP C_jdv_tree_scalar_text(SEXP x);
SEXP C_jdv_tree_names(SEXP x);
SEXP C_jdv_tree_vector_names(SEXP x, SEXP start, SEXP count);
void R_unload_jdv(DllInfo *dll);

JDV_WRAP_1(jdv_entry_int64_is_na, C_jdv_int64_is_na)
JDV_WRAP_1(jdv_entry_int64_values, C_jdv_int64_values)
JDV_WRAP_1(jdv_entry_int64_rank, C_jdv_int64_rank)
JDV_WRAP_2(jdv_entry_int64_order, C_jdv_int64_order)
JDV_WRAP_2(jdv_entry_int64_eq, C_jdv_int64_eq)
JDV_WRAP_3(jdv_entry_int64_between, C_jdv_int64_between)
JDV_WRAP_2(jdv_entry_json_parse, C_jdv_json_parse)
JDV_WRAP_3(jdv_entry_json_encode, C_jdv_json_encode)
JDV_WRAP_4(jdv_entry_transport_connect, C_jdv_transport_connect)
JDV_WRAP_1(jdv_entry_transport_send, C_jdv_transport_send)
JDV_WRAP_0(jdv_entry_transport_poll, C_jdv_transport_poll)
JDV_WRAP_0(jdv_entry_transport_close, C_jdv_transport_close)
JDV_WRAP_0(jdv_entry_transport_status, C_jdv_transport_status)
JDV_WRAP_0(jdv_entry_transport_can_unload, C_jdv_transport_can_unload)
JDV_WRAP_0(jdv_entry_transport_housekeeping,
           C_jdv_transport_housekeeping)
JDV_WRAP_0(jdv_entry_transport_cleanup, C_jdv_transport_cleanup)
JDV_WRAP_1(jdv_entry_tree_info, C_jdv_tree_info)
JDV_WRAP_4(jdv_entry_tree_child, C_jdv_tree_child)
JDV_WRAP_2(jdv_entry_tree_same, C_jdv_tree_same)
JDV_WRAP_1(jdv_entry_tree_scalar_text, C_jdv_tree_scalar_text)
JDV_WRAP_1(jdv_entry_tree_names, C_jdv_tree_names)
JDV_WRAP_3(jdv_entry_tree_vector_names, C_jdv_tree_vector_names)

JDV_WRAP_1(jdv_entry_arrow_move, C_jdv_arrow_move)
JDV_WRAP_1(jdv_entry_arrow_schema, C_jdv_arrow_schema)
JDV_WRAP_1(jdv_entry_arrow_next, C_jdv_arrow_next)
JDV_WRAP_1(jdv_entry_arrow_close, C_jdv_arrow_close)
JDV_WRAP_1(jdv_entry_arrow_info, C_jdv_arrow_info)
JDV_WRAP_0(jdv_entry_arrow_cleanup, C_jdv_arrow_cleanup)
JDV_WRAP_0(jdv_entry_arrow_status, C_jdv_arrow_status)
JDV_WRAP_1(jdv_entry_arrow_open, C_jdv_arrow_open)
JDV_WRAP_3(jdv_entry_arrow_page, C_jdv_arrow_page)

static const R_CallMethodDef CallEntries[] = {
    {"C_jdv_arrow_move", (DL_FUNC)&jdv_entry_arrow_move, 1},
    {"C_jdv_arrow_schema", (DL_FUNC)&jdv_entry_arrow_schema, 1},
    {"C_jdv_arrow_next", (DL_FUNC)&jdv_entry_arrow_next, 1},
    {"C_jdv_arrow_close", (DL_FUNC)&jdv_entry_arrow_close, 1},
    {"C_jdv_arrow_info", (DL_FUNC)&jdv_entry_arrow_info, 1},
    {"C_jdv_arrow_cleanup", (DL_FUNC)&jdv_entry_arrow_cleanup, 0},
    {"C_jdv_arrow_status", (DL_FUNC)&jdv_entry_arrow_status, 0},
    {"C_jdv_arrow_open", (DL_FUNC)&jdv_entry_arrow_open, 1},
    {"C_jdv_arrow_page", (DL_FUNC)&jdv_entry_arrow_page, 3},
    {"C_jdv_int64_is_na", (DL_FUNC)&jdv_entry_int64_is_na, 1},
    {"C_jdv_int64_values", (DL_FUNC)&jdv_entry_int64_values, 1},
    {"C_jdv_int64_rank", (DL_FUNC)&jdv_entry_int64_rank, 1},
    {"C_jdv_int64_order", (DL_FUNC)&jdv_entry_int64_order, 2},
    {"C_jdv_int64_eq", (DL_FUNC)&jdv_entry_int64_eq, 2},
    {"C_jdv_int64_between", (DL_FUNC)&jdv_entry_int64_between, 3},
    {"C_jdv_json_parse", (DL_FUNC)&jdv_entry_json_parse, 2},
    {"C_jdv_json_encode", (DL_FUNC)&jdv_entry_json_encode, 3},
    {"C_jdv_transport_connect", (DL_FUNC)&jdv_entry_transport_connect, 4},
    {"C_jdv_transport_send", (DL_FUNC)&jdv_entry_transport_send, 1},
    {"C_jdv_transport_poll", (DL_FUNC)&jdv_entry_transport_poll, 0},
    {"C_jdv_transport_close", (DL_FUNC)&jdv_entry_transport_close, 0},
    {"C_jdv_transport_status", (DL_FUNC)&jdv_entry_transport_status, 0},
    {"C_jdv_transport_can_unload", (DL_FUNC)&jdv_entry_transport_can_unload, 0},
    {"C_jdv_transport_housekeeping", (DL_FUNC)&jdv_entry_transport_housekeeping, 0},
    {"C_jdv_transport_cleanup", (DL_FUNC)&jdv_entry_transport_cleanup, 0},
    {"C_jdv_tree_info", (DL_FUNC)&jdv_entry_tree_info, 1},
    {"C_jdv_tree_child", (DL_FUNC)&jdv_entry_tree_child, 4},
    {"C_jdv_tree_same", (DL_FUNC)&jdv_entry_tree_same, 2},
    {"C_jdv_tree_scalar_text", (DL_FUNC)&jdv_entry_tree_scalar_text, 1},
    {"C_jdv_tree_names", (DL_FUNC)&jdv_entry_tree_names, 1},
    {"C_jdv_tree_vector_names", (DL_FUNC)&jdv_entry_tree_vector_names, 3},
    {NULL, NULL, 0}
};

static const R_CMethodDef CEntries[] = {
    {"R_unload_jdv", (DL_FUNC)&R_unload_jdv, 1},
    {NULL, NULL, 0}
};

void attribute_visible R_init_jdv(DllInfo *dll)
{
    R_registerRoutines(dll, CEntries, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}

static SEXP unload_body(void *data)
{
    (void)data;
    jdv_transport_unload();
    jdv_arrow_unload();
    return R_NilValue;
}

static void unload_done(void *data)
{
    (void)data;
    module_unloading = 0;
}

void R_unload_jdv(DllInfo *dll)
{
    if (module_unloading || module_depth || !jdv_arrow_can_unload())
        Rf_error("Cannot unload jdv while native callbacks are active.");
    module_unloading = 1;
    (void)R_ExecWithCleanup(unload_body, dll, unload_done, dll);
}
