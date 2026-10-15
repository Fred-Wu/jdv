#include <R.h>
#include <Rinternals.h>
#include <R_ext/Utils.h>
#include <nanoarrow/nanoarrow.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arrow.h"
#include "transport.h"

/* Tokens contain no native address or finalizer. Registry identity also makes
 * tokens from a previous DLL load permanently distinct from new tokens. */
typedef enum { JDV_ARROW_STREAM, JDV_ARROW_SCHEMA, JDV_ARROW_ARRAY } jdv_arrow_kind;
typedef struct jdv_arrow_record {
    SEXP token;
    int preserved;
    jdv_arrow_kind kind;
    union {
        struct ArrowArrayStream stream;
        struct ArrowSchema schema;
        struct ArrowArray array;
    } value;
    struct jdv_arrow_record *next;
} jdv_arrow_record;

typedef struct {
    SEXP argument;
    jdv_arrow_record *pending;
    int entered;
} jdv_arrow_call;

static jdv_arrow_record *registry = NULL;
static int operation_depth = 0;
static int reclamation_depth = 0;
static int cleanup_depth = 0;
static int cleanup_requested = 0;

static int cleanup_registry(void);

static jdv_arrow_record *find_record(SEXP token)
{
    jdv_arrow_record *record;
    if (TYPEOF(token) != ENVSXP) return NULL;
    for (record = registry; record; record = record->next)
        if (record->token == token) return record;
    return NULL;
}

static jdv_arrow_record *require_record(SEXP token, jdv_arrow_kind kind)
{
    jdv_arrow_record *record = find_record(token);
    if (!record || record->kind != kind)
        Rf_error("Arrow token is closed, stale, or has the wrong kind.");
    return record;
}

static void detach_record(jdv_arrow_record *record)
{
    jdv_arrow_record **link = &registry;
    while (*link && *link != record) link = &(*link)->next;
    if (*link == record) *link = record->next;
    record->next = NULL;
}

static SEXP release_body(void *data)
{
    jdv_arrow_record *record = (jdv_arrow_record *)data;
    /* Move before calling foreign code: a reentrant close cannot find or
     * release this resource again, even if the producer jumps out of release. */
    if (record->kind == JDV_ARROW_STREAM && record->value.stream.release) {
        struct ArrowArrayStream local;
        ArrowArrayStreamMove(&record->value.stream, &local);
        local.release(&local);
    } else if (record->kind == JDV_ARROW_SCHEMA && record->value.schema.release) {
        struct ArrowSchema local;
        ArrowSchemaMove(&record->value.schema, &local);
        local.release(&local);
    } else if (record->kind == JDV_ARROW_ARRAY && record->value.array.release) {
        struct ArrowArray local;
        ArrowArrayMove(&record->value.array, &local);
        local.release(&local);
    }
    return R_NilValue;
}

static void release_cleanup(void *data)
{
    jdv_arrow_record *record = (jdv_arrow_record *)data;
    if (record->preserved) R_ReleaseObject(record->token);
    free(record);
    reclamation_depth--;
}

static void release_record(jdv_arrow_record *record)
{
    detach_record(record);
    reclamation_depth++;
    (void)R_ExecWithCleanup(release_body, record, release_cleanup, record);
}

static void release_top_level(void *data)
{
    release_record((jdv_arrow_record *)data);
}

static SEXP cleanup_body(void *data)
{
    int *failures = (int *)data;
    while (registry) {
        jdv_arrow_record *record = registry;
        /* A non-returning foreign release is not retried. Other registry
         * records still need cleanup; its producer's partial cleanup cannot
         * be repaired safely by the consumer. */
        if (!R_ToplevelExec(release_top_level, record)) (*failures)++;
    }
    return R_NilValue;
}

static void cleanup_done(void *data)
{
    (void)data;
    cleanup_depth--;
}

static int cleanup_registry(void)
{
    int failures = 0;
    if (operation_depth || reclamation_depth || cleanup_depth) {
        cleanup_requested = 1;
        return -1;
    }
    cleanup_requested = 0;
    cleanup_depth++;
    (void)R_ExecWithCleanup(cleanup_body, &failures, cleanup_done, NULL);
    cleanup_requested = 0;
    return failures;
}

static void operation_done(void *data)
{
    (void)data;
    if (cleanup_requested && !operation_depth && !reclamation_depth && !cleanup_depth)
        (void)cleanup_registry();
}

static SEXP release_pending(void *data)
{
    release_record((jdv_arrow_record *)data);
    return R_NilValue;
}

static void operation_cleanup(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *pending = call->pending;
    call->pending = NULL;
    if (call->entered) {
        operation_depth--;
        call->entered = 0;
    }
    if (pending)
        (void)R_ExecWithCleanup(release_pending, pending, operation_done, NULL);
    else
        operation_done(NULL);
}

static SEXP run_operation(SEXP argument, SEXP (*body)(void *))
{
    jdv_arrow_call call;
    if (operation_depth || reclamation_depth || cleanup_depth)
        Rf_error("Arrow ownership operations cannot reenter a producer callback.");
    memset(&call, 0, sizeof(call));
    call.argument = argument;
    call.entered = 1;
    operation_depth++;
    return R_ExecWithCleanup(body, &call, operation_cleanup, &call);
}

static jdv_arrow_record *new_record(jdv_arrow_call *call, jdv_arrow_kind kind)
{
    SEXP token, klass;
    jdv_arrow_record *record = (jdv_arrow_record *)calloc(1, sizeof(*record));
    if (!record) Rf_error("Could not allocate an Arrow ownership record.");
    call->pending = record;
    record->kind = kind;
    record->token = R_NilValue;
    token = PROTECT(R_NewEnv(R_EmptyEnv, FALSE, 0));
    klass = PROTECT(Rf_mkString("jdv_arrow_token"));
    Rf_classgets(token, klass);
    record->token = token;
    R_PreserveObject(token);
    record->preserved = 1;
    UNPROTECT(2);
    return record;
}

static SEXP commit_record(jdv_arrow_call *call)
{
    jdv_arrow_record *record = call->pending;
    if (cleanup_requested)
        Rf_error("Arrow cleanup was requested during this operation.");
    record->next = registry;
    registry = record;
    call->pending = NULL;
    return record->token;
}

static void copy_stream_error(struct ArrowArrayStream *stream, char *target,
                              size_t size)
{
    const char *message = stream->get_last_error ? stream->get_last_error(stream) : NULL;
    snprintf(target, size, "%s", message ? message : "No producer error message.");
}

static SEXP move_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    struct ArrowArrayStream *source;
    jdv_arrow_record *record;
    if (TYPEOF(call->argument) != EXTPTRSXP ||
        !Rf_inherits(call->argument, "nanoarrow_array_stream"))
        Rf_error("Expected an exported nanoarrow_array_stream pointer.");
    source = (struct ArrowArrayStream *)R_ExternalPtrAddr(call->argument);
    if (!source || !source->release || !source->get_schema || !source->get_next)
        Rf_error("The exported Arrow stream is NULL, released, or incomplete.");
    record = new_record(call, JDV_ARROW_STREAM);
    ArrowArrayStreamMove(source, &record->value.stream);
    return commit_record(call);
}

static SEXP schema_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *source = require_record(call->argument, JDV_ARROW_STREAM);
    jdv_arrow_record *record = new_record(call, JDV_ARROW_SCHEMA);
    char error_copy[1024];
    int code = source->value.stream.get_schema(&source->value.stream, &record->value.schema);
    if (code) {
        copy_stream_error(&source->value.stream, error_copy, sizeof(error_copy));
        Rf_error("Arrow get_schema failed (%d): %s", code, error_copy);
    }
    if (!record->value.schema.release)
        Rf_error("Arrow get_schema returned no owned schema.");
    return commit_record(call);
}

static SEXP next_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *source = require_record(call->argument, JDV_ARROW_STREAM);
    jdv_arrow_record *record = new_record(call, JDV_ARROW_ARRAY);
    char error_copy[1024];
    int code = source->value.stream.get_next(&source->value.stream, &record->value.array);
    if (code) {
        copy_stream_error(&source->value.stream, error_copy, sizeof(error_copy));
        Rf_error("Arrow get_next failed (%d): %s", code, error_copy);
    }
    if (!record->value.array.release) return R_NilValue;
    return commit_record(call);
}

SEXP C_jdv_arrow_move(SEXP exported) { return run_operation(exported, move_body); }
SEXP C_jdv_arrow_schema(SEXP token) { return run_operation(token, schema_body); }
SEXP C_jdv_arrow_next(SEXP token) { return run_operation(token, next_body); }

static SEXP close_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    release_record(find_record(call->argument));
    return Rf_ScalarLogical(TRUE);
}

SEXP C_jdv_arrow_close(SEXP token)
{
    if (TYPEOF(token) != ENVSXP) Rf_error("Expected an Arrow ownership token.");
    if (!find_record(token)) return Rf_ScalarLogical(FALSE);
    return run_operation(token, close_body);
}

static SEXP info_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *record = find_record(call->argument);
    SEXP out, names;
    if (!record) Rf_error("Arrow token is closed or stale.");
    out = PROTECT(Rf_allocVector(VECSXP, 2));
    names = PROTECT(Rf_allocVector(STRSXP, 2));
    SET_STRING_ELT(names, 0, Rf_mkChar("kind"));
    SET_STRING_ELT(names, 1, Rf_mkChar("value"));
    SET_VECTOR_ELT(out, 0, Rf_mkString(record->kind == JDV_ARROW_STREAM ? "stream" :
                                    record->kind == JDV_ARROW_SCHEMA ? "schema" : "array"));
    if (record->kind == JDV_ARROW_SCHEMA && record->value.schema.format) {
        SET_VECTOR_ELT(out, 1, Rf_mkString(record->value.schema.format));
    } else if (record->kind == JDV_ARROW_ARRAY) {
        char length[32];
        snprintf(length, sizeof(length), "%" PRId64, record->value.array.length);
        SET_VECTOR_ELT(out, 1, Rf_mkString(length));
    }
    Rf_setAttrib(out, R_NamesSymbol, names);
    UNPROTECT(2);
    return out;
}

SEXP C_jdv_arrow_info(SEXP token) { return run_operation(token, info_body); }

SEXP C_jdv_arrow_cleanup(void) { return Rf_ScalarInteger(cleanup_registry()); }

int jdv_arrow_can_unload(void)
{
    return !operation_depth && !reclamation_depth && !cleanup_depth;
}

SEXP C_jdv_arrow_status(void)
{
    SEXP out, names;
    jdv_arrow_record *record;
    int counts[3] = {0, 0, 0};
    for (record = registry; record; record = record->next) counts[record->kind]++;
    out = PROTECT(Rf_allocVector(INTSXP, 4));
    names = PROTECT(Rf_allocVector(STRSXP, 4));
    INTEGER(out)[0] = counts[0]; INTEGER(out)[1] = counts[1]; INTEGER(out)[2] = counts[2];
    INTEGER(out)[3] = !jdv_arrow_can_unload();
    SET_STRING_ELT(names, 0, Rf_mkChar("stream"));
    SET_STRING_ELT(names, 1, Rf_mkChar("schema"));
    SET_STRING_ELT(names, 2, Rf_mkChar("array"));
    SET_STRING_ELT(names, 3, Rf_mkChar("busy"));
    Rf_setAttrib(out, R_NamesSymbol, names);
    UNPROTECT(2);
    return out;
}

void jdv_arrow_unload(void)
{
    if (jdv_module_depth() || !jdv_arrow_can_unload())
        Rf_error("Cannot unload jdv while Arrow ownership callbacks are active.");
    (void)cleanup_registry();
}
