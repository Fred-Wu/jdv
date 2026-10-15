/* Independent synthetic Arrow producer. The public nanoarrow R header supplies
 * only the C Data/Stream ABI; no producer or R implementation is copied here. */
#include <nanoarrow/r.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    int refs;
    int mode;
    int position;
    int size;
    int lengths[128];
    SEXP hook;
    char error[128];
} owner_state;

typedef struct {
    owner_state *state;
    const void *validity;
} owner_array;

static int counts[3] = {0, 0, 0};
static int states = 0;

static void call_hook(owner_state *state, const char *event)
{
    if (state->hook != R_NilValue) {
        SEXP text = PROTECT(Rf_mkString(event));
        SEXP call = PROTECT(Rf_lang2(state->hook, text));
        Rf_eval(call, R_GlobalEnv);
        UNPROTECT(2);
    }
}

static void drop_state(owner_state *state)
{
    if (--state->refs == 0) {
        if (state->hook != R_NilValue) R_ReleaseObject(state->hook);
        free(state);
        states--;
    }
}

typedef struct { owner_state *state; void *allocation; const char *event; } owner_release;
static SEXP release_callback(void *data)
{
    owner_release *release = (owner_release *)data;
    call_hook(release->state, release->event);
    return R_NilValue;
}
static void release_cleanup(void *data)
{
    owner_release *release = (owner_release *)data;
    free(release->allocation);
    drop_state(release->state);
}

static void schema_release(struct ArrowSchema *schema)
{
    owner_release release = {(owner_state *)schema->private_data, NULL, "schema_release"};
    counts[1]++;
    strcpy(release.state->error, "overwritten by schema release");
    if (release.state->mode != 4) {
        schema->release = NULL;
        schema->private_data = NULL;
    }
    (void)R_ExecWithCleanup(release_callback, &release, release_cleanup, &release);
    schema->release = NULL;
    schema->private_data = NULL;
}

static void array_release(struct ArrowArray *array)
{
    owner_array *private_data = (owner_array *)array->private_data;
    owner_release release = {private_data->state, private_data, "array_release"};
    counts[2]++;
    strcpy(release.state->error, "overwritten by array release");
    if (release.state->mode != 4) {
        array->release = NULL;
        array->private_data = NULL;
    }
    (void)R_ExecWithCleanup(release_callback, &release, release_cleanup, &release);
    array->release = NULL;
    array->private_data = NULL;
}

static void stream_release(struct ArrowArrayStream *stream)
{
    owner_release release = {(owner_state *)stream->private_data, NULL, "stream_release"};
    counts[0]++;
    stream->release = NULL;
    stream->private_data = NULL;
    (void)R_ExecWithCleanup(release_callback, &release, release_cleanup, &release);
}

static int get_schema(struct ArrowArrayStream *stream, struct ArrowSchema *schema)
{
    owner_state *state = (owner_state *)stream->private_data;
    memset(schema, 0, sizeof(*schema));
    state->refs++;
    schema->format = "+s";
    schema->release = schema_release;
    schema->private_data = state;
    call_hook(state, "schema");
    if (state->mode == 2) {
        strcpy(state->error, "original schema producer error");
        return 5;
    }
    return 0;
}

static int get_next(struct ArrowArrayStream *stream, struct ArrowArray *array)
{
    owner_state *state = (owner_state *)stream->private_data;
    owner_array *private_data;
    memset(array, 0, sizeof(*array));
    if (state->position == state->size && state->mode != 1) {
        if (state->mode == 3) array->length = 99;
        return 0;
    }
    private_data = (owner_array *)calloc(1, sizeof(*private_data));
    if (!private_data) Rf_error("fixture allocation failed");
    state->refs++;
    private_data->state = state;
    array->length = state->mode == 1 ? 0 : state->lengths[state->position++];
    array->n_buffers = 1;
    array->buffers = &private_data->validity;
    array->release = array_release;
    array->private_data = private_data;
    call_hook(state, "next");
    if (state->mode == 1 || state->mode == 4) {
        strcpy(state->error, "original array producer error");
        return 5;
    }
    return 0;
}

static const char *get_error(struct ArrowArrayStream *stream)
{
    return ((owner_state *)stream->private_data)->error;
}

static SEXP owner_init(SEXP pointer, SEXP lengths, SEXP mode, SEXP hook)
{
    struct ArrowArrayStream *stream;
    owner_state *state;
    if (TYPEOF(pointer) != EXTPTRSXP || TYPEOF(lengths) != INTSXP || XLENGTH(lengths) > 128)
        Rf_error("invalid fixture arguments");
    stream = (struct ArrowArrayStream *)R_ExternalPtrAddr(pointer);
    if (!stream || stream->release) Rf_error("fixture destination must be empty");
    state = (owner_state *)calloc(1, sizeof(*state));
    if (!state) Rf_error("fixture allocation failed");
    state->refs = 1;
    state->mode = Rf_asInteger(mode);
    state->size = (int)XLENGTH(lengths);
    for (int i = 0; i < state->size; i++) state->lengths[i] = INTEGER(lengths)[i];
    state->hook = hook;
    if (hook != R_NilValue) R_PreserveObject(hook);
    states++;
    stream->get_schema = get_schema;
    stream->get_next = get_next;
    stream->get_last_error = get_error;
    stream->release = stream_release;
    stream->private_data = state;
    return pointer;
}

static SEXP owner_counts(void)
{
    SEXP out = PROTECT(Rf_allocVector(INTSXP, 4));
    for (int i = 0; i < 3; i++) INTEGER(out)[i] = counts[i];
    INTEGER(out)[3] = states;
    UNPROTECT(1);
    return out;
}

static const R_CallMethodDef methods[] = {
    {"owner_init", (DL_FUNC)&owner_init, 4},
    {"owner_counts", (DL_FUNC)&owner_counts, 0},
    {NULL, NULL, 0}
};
void attribute_visible R_init_ownerfixture(DllInfo *dll)
{
    R_registerRoutines(dll, NULL, methods, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
