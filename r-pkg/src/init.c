#include <R.h>
#include <R_ext/Rdynload.h>
#include "int64.h"

SEXP C_jdv_json_parse(SEXP input, SEXP max_bytes);
SEXP C_jdv_json_encode(SEXP object, SEXP max_bytes, SEXP max_work_bytes);

static const R_CallMethodDef CallEntries[] = {
    {"C_jdv_int64_is_na", (DL_FUNC)&C_jdv_int64_is_na, 1},
    {"C_jdv_int64_values", (DL_FUNC)&C_jdv_int64_values, 1},
    {"C_jdv_int64_rank", (DL_FUNC)&C_jdv_int64_rank, 1},
    {"C_jdv_int64_order", (DL_FUNC)&C_jdv_int64_order, 2},
    {"C_jdv_int64_eq", (DL_FUNC)&C_jdv_int64_eq, 2},
    {"C_jdv_int64_between", (DL_FUNC)&C_jdv_int64_between, 3},
    {"C_jdv_json_parse", (DL_FUNC)&C_jdv_json_parse, 2},
    {"C_jdv_json_encode", (DL_FUNC)&C_jdv_json_encode, 3},
    {NULL, NULL, 0}
};

void R_init_jdv(DllInfo *dll)
{
    R_registerRoutines(dll, NULL, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
