#ifndef JDV_INT64_H
#define JDV_INT64_H

#include <Rinternals.h>

SEXP C_jdv_int64_is_na(SEXP x);
SEXP C_jdv_int64_values(SEXP x);
SEXP C_jdv_int64_rank(SEXP x);
SEXP C_jdv_int64_order(SEXP x, SEXP decreasing);
SEXP C_jdv_int64_eq(SEXP x, SEXP value);
SEXP C_jdv_int64_between(SEXP x, SEXP lower, SEXP upper);

#endif
