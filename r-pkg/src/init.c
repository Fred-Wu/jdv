#include <R.h>
#include <R_ext/Rdynload.h>

static const R_CallMethodDef CallEntries[] = {
    {NULL, NULL, 0}
};

void R_init_jdv(DllInfo *dll)
{
    R_registerRoutines(dll, NULL, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}
