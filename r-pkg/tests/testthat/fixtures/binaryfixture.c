#include <R.h>
#include <Rinternals.h>
#include <R_ext/Altrep.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>

static R_altrep_class_t failing_raw_class;
static R_altrep_class_t header_class;

static R_xlen_t raw_length(SEXP value)
{
    (void)value;
    return 4;
}

static void *raw_data(SEXP value, Rboolean writeable)
{
    (void)value;
    (void)writeable;
    Rf_error("Intentional raw producer materialization error.");
    return NULL;
}

static SEXP new_failing_raw(void)
{
    return R_new_altrep(failing_raw_class, R_NilValue, R_NilValue);
}

static R_xlen_t header_length(SEXP value)
{
    (void)value;
    return 1;
}

static SEXP header_element(SEXP value, R_xlen_t index)
{
    (void)index;
    int *state = INTEGER(R_altrep_data2(value));
    if (++state[0] > state[1])
        Rf_error("Intentional header producer element error.");
    return STRING_ELT(R_altrep_data1(value), 0);
}

static SEXP new_header(SEXP text, SEXP limit)
{
    SEXP state = PROTECT(Rf_allocVector(INTSXP, 2));
    INTEGER(state)[0] = 0;
    INTEGER(state)[1] = Rf_asInteger(limit);
    SEXP value = R_new_altrep(header_class, text, state);
    UNPROTECT(1);
    return value;
}

void attribute_visible R_init_binaryfixture(DllInfo *dll)
{
    static const R_CallMethodDef calls[] = {
        {"new_failing_raw", (DL_FUNC)&new_failing_raw, 0},
        {"new_header", (DL_FUNC)&new_header, 2},
        {NULL, NULL, 0}
    };
    failing_raw_class = R_make_altraw_class("failing_raw", "binaryfixture", dll);
    R_set_altrep_Length_method(failing_raw_class, raw_length);
    R_set_altvec_Dataptr_method(failing_raw_class, raw_data);
    header_class = R_make_altstring_class("header", "binaryfixture", dll);
    R_set_altrep_Length_method(header_class, header_length);
    R_set_altstring_Elt_method(header_class, header_element);
    R_registerRoutines(dll, NULL, calls, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
