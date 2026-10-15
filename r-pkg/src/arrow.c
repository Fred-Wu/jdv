#include <R.h>
#include <Rinternals.h>
#include <R_ext/Utils.h>
#include <nanoarrow/nanoarrow.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arrow.h"
#include "arrow-page.h"
#include "transport.h"

/* Tokens contain no native address or finalizer. Registry identity also makes
 * tokens from a previous DLL load permanently distinct from new tokens. */
typedef enum { JDV_ARROW_STREAM, JDV_ARROW_SCHEMA, JDV_ARROW_ARRAY } jdv_arrow_kind;
typedef struct {
    struct ArrowSchema schema;
    struct ArrowArray batch;
    int schema_live;
    int batch_live;
    int opened;
    int eof;
    int failed;
    int in_page;
    int64_t offset;
    int64_t rows_seen;
    char failed_code[64];
    char failed_message[1024];
} jdv_arrow_page_state;
typedef struct jdv_arrow_record {
    SEXP token;
    int preserved;
    jdv_arrow_kind kind;
    jdv_arrow_page_state *page;
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
    jdv_arrow_page_state *busy_page;
    void *pending_bytes;
} jdv_arrow_call;

static jdv_arrow_record *registry = NULL;
static int operation_depth = 0;
static int reclamation_depth = 0;
static int cleanup_depth = 0;
static int cleanup_requested = 0;

#define JDV_ARROW_PAGE_MAX_BYTES (10 * 1024 * 1024)

static int cleanup_registry(void);
static SEXP page_result_error(const char *code, const char *message, int terminal);
static void page_fail(jdv_arrow_record *record);

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

static void release_schema_safe(void *data)
{
    struct ArrowSchema *schema = (struct ArrowSchema *)data;
    if (schema->release) schema->release(schema);
}

static void release_array_safe(void *data)
{
    struct ArrowArray *array = (struct ArrowArray *)data;
    if (array->release) array->release(array);
}

static void release_stream_safe(void *data)
{
    struct ArrowArrayStream *stream = (struct ArrowArrayStream *)data;
    if (stream->release) stream->release(stream);
}

static void release_array_moved(struct ArrowArray *array)
{
    struct ArrowArray local;
    memset(&local, 0, sizeof(local));
    ArrowArrayMove(array, &local);
    if (local.release) (void)R_ToplevelExec(release_array_safe, &local);
}

static void release_schema_moved(struct ArrowSchema *schema)
{
    struct ArrowSchema local;
    memset(&local, 0, sizeof(local));
    ArrowSchemaMove(schema, &local);
    if (local.release) (void)R_ToplevelExec(release_schema_safe, &local);
}

static void release_page_state(jdv_arrow_page_state *page)
{
    if (!page) return;
    if (page->batch_live) {
        release_array_moved(&page->batch);
        page->batch_live = 0;
    }
    if (page->schema_live) {
        release_schema_moved(&page->schema);
        page->schema_live = 0;
    }
    free(page);
}

static SEXP release_body(void *data)
{
    jdv_arrow_record *record = (jdv_arrow_record *)data;
    /* Move before calling foreign code: a reentrant close cannot find or
     * release this resource again, even if the producer jumps out of release. */
    if (record->kind == JDV_ARROW_STREAM) {
        release_page_state(record->page);
        record->page = NULL;
    }
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

static void operation_finish(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    if (call->entered) {
        operation_depth--;
        call->entered = 0;
    }
    operation_done(NULL);
}

static void operation_cleanup(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *pending = call->pending;
    call->pending = NULL;
    if (call->busy_page) {
        if (!call->busy_page->batch_live && call->busy_page->batch.release)
            release_array_moved(&call->busy_page->batch);
        if (!call->busy_page->schema_live && call->busy_page->schema.release)
            release_schema_moved(&call->busy_page->schema);
        call->busy_page->in_page = 0;
        call->busy_page = NULL;
    }
    free(call->pending_bytes);
    call->pending_bytes = NULL;
    if (pending) {
        (void)R_ToplevelExec(release_top_level, pending);
    }
    operation_finish(call);
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

typedef struct {
    struct ArrowArrayStream *stream;
    struct ArrowSchema *schema;
    struct ArrowArray *array;
    int code;
    char *error;
    int raised_error;
} jdv_arrow_producer_call;

static SEXP producer_schema_body(void *data)
{
    jdv_arrow_producer_call *call = (jdv_arrow_producer_call *)data;
    call->code = call->stream->get_schema(call->stream, call->schema);
    return R_NilValue;
}

static SEXP producer_next_body(void *data)
{
    jdv_arrow_producer_call *call = (jdv_arrow_producer_call *)data;
    call->code = call->stream->get_next(call->stream, call->array);
    return R_NilValue;
}

static SEXP producer_error_body(void *data)
{
    jdv_arrow_producer_call *call = (jdv_arrow_producer_call *)data;
    const char *message = call->stream->get_last_error
                              ? call->stream->get_last_error(call->stream)
                              : NULL;
    snprintf(call->error, 1024, "%s",
             message ? message : "Arrow producer callback failed.");
    return R_NilValue;
}

static SEXP producer_error_handler(SEXP condition, void *data)
{
    jdv_arrow_producer_call *call = (jdv_arrow_producer_call *)data;
    (void)condition;
    call->raised_error = 1;
    return R_NilValue;
}

static void producer_schema_safe_body(void *data)
{
    (void)R_tryCatchError(producer_schema_body, data,
                          producer_error_handler, data);
}

static void producer_next_safe_body(void *data)
{
    (void)R_tryCatchError(producer_next_body, data,
                          producer_error_handler, data);
}

static void producer_error_safe_body(void *data)
{
    (void)R_tryCatchError(producer_error_body, data,
                          producer_error_handler, data);
}

static void set_page_failure(jdv_arrow_page_state *page, const char *code,
                             const char *message)
{
    if (!page) return;
    page->failed = 1;
    snprintf(page->failed_code, sizeof(page->failed_code), "%s",
             code ? code : "failed");
    snprintf(page->failed_message, sizeof(page->failed_message), "%s",
             message ? message : "Arrow page cursor has failed.");
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
    if (source->page)
        Rf_error("Arrow stream is owned by the sequential page cursor.");
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
    if (source->page)
        Rf_error("Arrow stream is owned by the sequential page cursor.");
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

static SEXP named_list(int n, const char **labels)
{
    SEXP out = PROTECT(Rf_allocVector(VECSXP, n));
    SEXP names = PROTECT(Rf_allocVector(STRSXP, n));
    int i;
    for (i = 0; i < n; i++) SET_STRING_ELT(names, i, Rf_mkChar(labels[i]));
    Rf_setAttrib(out, R_NamesSymbol, names);
    UNPROTECT(2);
    return out;
}

static char *schema_metadata_hex(const char *metadata)
{
    static const char digits[] = "0123456789abcdef";
    int32_t n, key_size, value_size;
    int64_t i, size;
    const unsigned char *p = (const unsigned char *)metadata;
    char *out;
    if (!metadata) return NULL;
    memcpy(&n, p, sizeof(n));
    if (n < 0 || n > 100000) return NULL;
    size = 4;
    p += 4;
    for (i = 0; i < n; i++) {
        memcpy(&key_size, p, 4); p += 4; size += 4 + key_size;
        if (key_size < 0 || size > INT32_MAX) return NULL;
        p += key_size;
        memcpy(&value_size, p, 4); p += 4; size += 4 + value_size;
        if (value_size < 0 || size > INT32_MAX) return NULL;
        p += value_size;
    }
    out = (char *)malloc((size_t)size * 2 + 1);
    if (!out) return NULL;
    p = (const unsigned char *)metadata;
    for (i = 0; i < size; i++) {
        out[i * 2] = digits[p[i] >> 4];
        out[i * 2 + 1] = digits[p[i] & 15];
    }
    out[size * 2] = '\0';
    return out;
}

static SEXP schema_descriptor(const struct ArrowSchema *schema)
{
    static const char *labels[] = {"format", "name", "flags", "metadata",
                                   "metadata_encoding", "children", "dictionary"};
    SEXP out = PROTECT(named_list(7, labels));
    SEXP children = PROTECT(Rf_allocVector(VECSXP, (R_xlen_t)schema->n_children));
    char *metadata = schema_metadata_hex(schema->metadata);
    int64_t i;
    if (schema->format) SET_VECTOR_ELT(out, 0, Rf_mkString(schema->format));
    if (schema->name) SET_VECTOR_ELT(out, 1, Rf_mkString(schema->name));
    SET_VECTOR_ELT(out, 2, Rf_ScalarInteger(schema->flags));
    if (metadata) {
        SET_VECTOR_ELT(out, 3, Rf_mkString(metadata));
        SET_VECTOR_ELT(out, 4, Rf_mkString("hex"));
        free(metadata);
    }
    for (i = 0; i < schema->n_children; i++) {
        SEXP child = PROTECT(schema_descriptor(schema->children[i]));
        SET_VECTOR_ELT(children, i, child);
        UNPROTECT(1);
    }
    SET_VECTOR_ELT(out, 5, children);
    if (schema->dictionary) {
        SEXP dict = PROTECT(schema_descriptor(schema->dictionary));
        SET_VECTOR_ELT(out, 6, dict);
        UNPROTECT(1);
    }
    UNPROTECT(2);
    return out;
}

static const char *unsupported_schema_reason(const struct ArrowSchema *schema)
{
    struct ArrowSchemaView view;
    struct ArrowError error;
    int64_t i;
    if (ArrowSchemaViewInit(&view, schema, &error) != NANOARROW_OK)
        return "invalid Arrow schema";
    if (view.type == NANOARROW_TYPE_DENSE_UNION ||
        view.type == NANOARROW_TYPE_SPARSE_UNION)
        return "union columns are not supported";
    if (view.type == NANOARROW_TYPE_LIST_VIEW ||
        view.type == NANOARROW_TYPE_LARGE_LIST_VIEW)
        return "list_view columns are not supported";
    if (schema->dictionary && schema->dictionary->n_children > 0)
        return "dictionary values with children are not supported";
    for (i = 0; i < schema->n_children; i++) {
        const char *reason = unsupported_schema_reason(schema->children[i]);
        if (reason) return reason;
    }
    return NULL;
}

static int validate_schema_recursive(const struct ArrowSchema *schema,
                                     char *message, size_t message_size)
{
    struct ArrowSchemaView view;
    struct ArrowError error;
    int64_t i;
    ArrowErrorInit(&error);
    if (schema == NULL || schema->release == NULL || schema->format == NULL ||
        schema->n_children < 0 ||
        (schema->n_children > 0 && schema->children == NULL)) {
        snprintf(message, message_size, "Arrow producer returned an invalid schema tree.");
        return 0;
    }
    if (ArrowSchemaViewInit(&view, schema, &error) != NANOARROW_OK) {
        snprintf(message, message_size, "%s",
                 error.message[0] ? error.message : "Arrow producer returned an invalid schema.");
        return 0;
    }
    if (schema->dictionary && !validate_schema_recursive(
                                  schema->dictionary, message, message_size))
        return 0;
    for (i = 0; i < schema->n_children; i++) {
        if (!validate_schema_recursive(schema->children[i], message, message_size))
            return 0;
    }
    return 1;
}

static SEXP page_open_body(void *data)
{
    jdv_arrow_call *call = (jdv_arrow_call *)data;
    jdv_arrow_record *record = require_record(call->argument, JDV_ARROW_STREAM);
    static const char *column_labels[] = {"index", "name", "type", "unsupported", "ipc_index"};
    jdv_arrow_page_state *page = record->page;
    SEXP out, columns, mapping;
    int64_t i, ipc_index = 0;
    char error_copy[1024];
    int code;
    if (page && page->failed) Rf_error("Arrow stream page cursor is failed.");
    if (!page) {
        page = (jdv_arrow_page_state *)calloc(1, sizeof(*page));
        if (!page) Rf_error("Could not allocate Arrow page cursor.");
        record->page = page;
    }
    call->busy_page = page;
    if (!page->opened) {
        jdv_arrow_producer_call producer;
        int callback_ok;
        memset(&page->schema, 0, sizeof(page->schema));
        memset(&producer, 0, sizeof(producer));
        producer.stream = &record->value.stream;
        producer.schema = &page->schema;
        callback_ok = R_ToplevelExec(producer_schema_safe_body, &producer);
        code = producer.code;
        if (code || !page->schema.release || !page->schema.format ||
            page->schema.n_children < 0 || !callback_ok || producer.raised_error) {
            if (!callback_ok || producer.raised_error) {
                snprintf(error_copy, sizeof(error_copy),
                         "Arrow get_schema callback raised an R error or interrupt.");
            } else {
                jdv_arrow_producer_call error_call;
                memset(&error_call, 0, sizeof(error_call));
                error_call.stream = &record->value.stream;
                error_call.error = error_copy;
                if (!R_ToplevelExec(producer_error_safe_body, &error_call) ||
                    error_call.raised_error)
                    snprintf(error_copy, sizeof(error_copy),
                             "Arrow get_schema failed (%d).", code);
            }
            set_page_failure(page, "producer_error", error_copy);
            page_fail(record);
            return page_result_error("producer_error", error_copy, 1);
        }
        page->schema_live = 1;
        if (!validate_schema_recursive(&page->schema, error_copy,
                                       sizeof(error_copy))) {
            set_page_failure(page, "producer_error", error_copy);
            page_fail(record);
            return page_result_error("producer_error", error_copy, 1);
        }
        page->opened = 1;
    }
    out = PROTECT(named_list(4, (const char *[]){"ok", "schema", "columns", "mapping"}));
    columns = PROTECT(Rf_allocVector(VECSXP, (R_xlen_t)page->schema.n_children));
    mapping = PROTECT(Rf_allocVector(VECSXP, (R_xlen_t)page->schema.n_children));
    for (i = 0; i < page->schema.n_children; i++) {
        const struct ArrowSchema *field = page->schema.children[i];
        const char *reason = unsupported_schema_reason(field);
        SEXP col = PROTECT(named_list(5, column_labels));
        SET_VECTOR_ELT(mapping, i, reason ? R_NilValue : Rf_ScalarInteger((int)ipc_index));
        SET_VECTOR_ELT(col, 0, Rf_ScalarInteger((int)i));
        if (field->name) SET_VECTOR_ELT(col, 1, Rf_mkString(field->name));
        if (field->format) SET_VECTOR_ELT(col, 2, Rf_mkString(field->format));
        if (reason) SET_VECTOR_ELT(col, 3, Rf_mkString(reason));
        if (reason) SET_VECTOR_ELT(col, 4, R_NilValue);
        else {
            SET_VECTOR_ELT(col, 4, Rf_ScalarInteger((int)ipc_index));
            ipc_index++;
        }
        SET_VECTOR_ELT(columns, i, col);
        UNPROTECT(1);
    }
    SET_VECTOR_ELT(out, 0, Rf_ScalarLogical(TRUE));
    SET_VECTOR_ELT(out, 1, schema_descriptor(&page->schema));
    SET_VECTOR_ELT(out, 2, columns);
    SET_VECTOR_ELT(out, 3, mapping);
    UNPROTECT(3);
    return out;
}

SEXP C_jdv_arrow_open(SEXP token) { return run_operation(token, page_open_body); }

typedef struct {
    jdv_arrow_call call;
    int64_t max_rows;
    int64_t max_bytes;
} jdv_arrow_page_call;

static SEXP page_result_error(const char *code, const char *message, int terminal)
{
    static const char *labels[] = {"ok", "code", "message", "terminal"};
    SEXP out = PROTECT(named_list(4, labels));
    SET_VECTOR_ELT(out, 0, Rf_ScalarLogical(FALSE));
    SET_VECTOR_ELT(out, 1, Rf_mkString(code));
    SET_VECTOR_ELT(out, 2, Rf_mkString(message));
    SET_VECTOR_ELT(out, 3, Rf_ScalarLogical(terminal));
    UNPROTECT(1);
    return out;
}

static SEXP page_result_success(uint8_t *payload, int64_t payload_size,
                                int64_t first_row, int64_t rows_fetched,
                                int done)
{
    static const char *labels[] = {"ok", "payload", "first_row",
                                   "rows_fetched", "rows_seen", "done"};
    SEXP out = PROTECT(named_list(6, labels));
    SEXP raw = PROTECT(Rf_allocVector(RAWSXP, (R_xlen_t)payload_size));
    if (payload_size > 0) memcpy(RAW(raw), payload, (size_t)payload_size);
    SET_VECTOR_ELT(out, 0, Rf_ScalarLogical(TRUE));
    SET_VECTOR_ELT(out, 1, raw);
    SET_VECTOR_ELT(out, 2, Rf_ScalarReal((double)first_row));
    SET_VECTOR_ELT(out, 3, Rf_ScalarReal((double)rows_fetched));
    SET_VECTOR_ELT(out, 4, Rf_ScalarReal((double)(first_row + rows_fetched)));
    SET_VECTOR_ELT(out, 5, Rf_ScalarLogical(done));
    UNPROTECT(2);
    return out;
}

static void page_fail(jdv_arrow_record *record)
{
    jdv_arrow_page_state *page = record->page;
    if (page) {
        if (!page->failed)
            set_page_failure(page, "failed", "Arrow page cursor has failed.");
        if (page->batch_live || page->batch.release) {
        release_array_moved(&page->batch);
            page->batch_live = 0;
        }
        if (page->schema_live || page->schema.release) {
        release_schema_moved(&page->schema);
            page->schema_live = 0;
        }
    }
    if (record->value.stream.release) {
        struct ArrowArrayStream local;
        ArrowArrayStreamMove(&record->value.stream, &local);
        if (local.release) (void)R_ToplevelExec(release_stream_safe, &local);
    }
}

static SEXP page_emit_empty(jdv_arrow_page_state *page, int64_t max_bytes,
                            int done, void **pending_bytes)
{
    uint8_t *payload = NULL;
    int64_t size = 0, rows = 0;
    struct ArrowError error;
    int code;
    ArrowErrorInit(&error);
    code = jdv_arrow_page_encode(&page->schema, NULL, 0, 0, max_bytes,
                                 &payload, &size, &rows, &error);
    if (code != NANOARROW_OK) {
        free(payload);
        return page_result_error(code == EOVERFLOW ? "limit_exceeded" : "encode_error",
                                 error.message[0] ? error.message : "Could not encode empty Arrow page.",
                                 0);
    }
    *pending_bytes = payload;
    {
        SEXP out = PROTECT(page_result_success(payload, size,
                                               page->rows_seen, 0, done));
        free(payload);
        *pending_bytes = NULL;
        UNPROTECT(1);
        return out;
    }
}

static int page_budget(SEXP value, int64_t max, int64_t *out)
{
    double d;
    if (XLENGTH(value) != 1 || (TYPEOF(value) != INTSXP && TYPEOF(value) != REALSXP))
        return 0;
    d = Rf_asReal(value);
    if (!R_FINITE(d) || d < 0 || d > (double)max || floor(d) != d) return 0;
    *out = (int64_t)d;
    return 1;
}

static SEXP page_body(void *data)
{
    jdv_arrow_page_call *args = (jdv_arrow_page_call *)data;
    jdv_arrow_call *call = &args->call;
    jdv_arrow_record *record = require_record(call->argument, JDV_ARROW_STREAM);
    jdv_arrow_page_state *page = record->page;
    int empty_batches = 0;
    if (!page || !page->opened)
        return page_result_error("invalid_request", "Call .jdv_stream_open() before requesting a page.", 0);
    if (page->failed)
        return page_result_error(page->failed_code[0] ? page->failed_code : "failed",
                                 page->failed_message[0] ? page->failed_message : "Arrow page cursor has failed.", 1);
    if (page->in_page)
        return page_result_error("in_use", "An Arrow page request is already active for this stream.", 0);
    page->in_page = 1;
    call->busy_page = page;
    if (page->eof)
        return page_emit_empty(page, args->max_bytes, 1, &call->pending_bytes);
    while (!page->batch_live) {
        char error_copy[1024];
        int code, callback_ok;
        jdv_arrow_producer_call producer;
        memset(&page->batch, 0, sizeof(page->batch));
        memset(&producer, 0, sizeof(producer));
        producer.stream = &record->value.stream;
        producer.array = &page->batch;
        callback_ok = R_ToplevelExec(producer_next_safe_body, &producer);
        code = producer.code;
        if (code || (page->batch.release && page->batch.length < 0) ||
            (page->batch.release && page->batch.length > 0 && !page->batch.children &&
             page->schema.n_children > 0) || !callback_ok || producer.raised_error) {
            if (!callback_ok || producer.raised_error) {
                snprintf(error_copy, sizeof(error_copy),
                         "Arrow get_next callback raised an R error or interrupt.");
            } else {
                jdv_arrow_producer_call error_call;
                memset(&error_call, 0, sizeof(error_call));
                error_call.stream = &record->value.stream;
                error_call.error = error_copy;
                if (!R_ToplevelExec(producer_error_safe_body, &error_call) ||
                    error_call.raised_error)
                    snprintf(error_copy, sizeof(error_copy),
                             "Arrow get_next failed (%d).", code);
            }
            set_page_failure(page, "producer_error", error_copy);
            page_fail(record);
            return page_result_error("producer_error", error_copy, 1);
        }
        if (!page->batch.release) {
            page->eof = 1;
            return page_emit_empty(page, args->max_bytes, 1,
                                   &call->pending_bytes);
        }
        {
            struct ArrowArrayView view;
            struct ArrowError validation_error;
            int validation_code;
            ArrowErrorInit(&validation_error);
            ArrowArrayViewInitFromType(&view, NANOARROW_TYPE_UNINITIALIZED);
            validation_code = ArrowArrayViewInitFromSchema(&view, &page->schema,
                                                            &validation_error);
            if (validation_code == NANOARROW_OK)
                validation_code = ArrowArrayViewSetArray(&view, &page->batch,
                                                         &validation_error);
            ArrowArrayViewReset(&view);
            if (validation_code != NANOARROW_OK) {
                const char *message = validation_error.message[0]
                                          ? validation_error.message
                                          : "Producer returned an invalid Arrow array.";
                char error_copy[1024];
                snprintf(error_copy, sizeof(error_copy), "%s", message);
                set_page_failure(page, "producer_error", error_copy);
                page_fail(record);
                return page_result_error("producer_error", error_copy, 1);
            }
        }
        page->batch_live = 1;
        if (page->batch.length > 0) break;
        release_array_moved(&page->batch);
        page->batch_live = 0;
        if (++empty_batches >= 64)
            return page_emit_empty(page, args->max_bytes, 0,
                                   &call->pending_bytes);
        R_CheckUserInterrupt();
    }
    {
        uint8_t *payload = NULL;
        int64_t size = 0, rows = 0, requested = args->max_rows;
        int code;
        struct ArrowError error;
        if (requested > page->batch.length - page->offset)
            requested = page->batch.length - page->offset;
        if (requested <= 0)
            return page_result_error("invalid_request", "Page row budget must be positive.", 0);
        ArrowErrorInit(&error);
        code = jdv_arrow_page_encode(&page->schema, &page->batch, page->offset,
                                     requested, args->max_bytes, &payload,
                                     &size, &rows, &error);
        while (code == EOVERFLOW && requested > 1) {
            requested = (requested + 1) / 2;
            ArrowErrorInit(&error);
            code = jdv_arrow_page_encode(&page->schema, &page->batch,
                                         page->offset, requested,
                                         args->max_bytes, &payload, &size,
                                         &rows, &error);
        }
        if (code == EOVERFLOW) {
            set_page_failure(page, "limit_exceeded",
                             "One Arrow row exceeds max_bytes.");
            page_fail(record);
            return page_result_error("limit_exceeded",
                                     "One Arrow row exceeds max_bytes.", 1);
        }
        if (code != NANOARROW_OK)
            return page_result_error("encode_error",
                                     error.message[0] ? error.message : "Could not encode Arrow page.", 0);
        {
            int64_t first = page->rows_seen;
            SEXP out;
            call->pending_bytes = payload;
            out = PROTECT(page_result_success(payload, size, first, rows, 0));
            page->offset += rows;
            page->rows_seen += rows;
            if (page->offset == page->batch.length) {
                release_array_moved(&page->batch);
                page->batch_live = 0;
                page->offset = 0;
            }
            free(payload);
            call->pending_bytes = NULL;
            UNPROTECT(1);
            return out;
        }
    }
}

static SEXP run_page_operation(SEXP token, SEXP max_rows, SEXP max_bytes)
{
    jdv_arrow_page_call call;
    if (operation_depth || reclamation_depth || cleanup_depth)
        Rf_error("Arrow ownership operations cannot reenter a producer callback.");
    memset(&call, 0, sizeof(call));
    call.call.argument = token;
    call.call.entered = 1;
    if (!page_budget(max_rows, 2000, &call.max_rows) || call.max_rows == 0)
        Rf_error("max_rows must be a positive whole number no greater than 2000.");
    if (!page_budget(max_bytes, JDV_ARROW_PAGE_MAX_BYTES, &call.max_bytes))
        Rf_error("max_bytes must be a nonnegative whole number no greater than 10 MiB.");
    operation_depth++;
    return R_ExecWithCleanup(page_body, &call, operation_cleanup, &call.call);
}

SEXP C_jdv_arrow_page(SEXP token, SEXP max_rows, SEXP max_bytes)
{
    return run_page_operation(token, max_rows, max_bytes);
}

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
