/* Independent integer64 storage handling using public R APIs and C headers. */
#include "int64.h"
#include <R_ext/Utils.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    int64_t value;
    R_xlen_t index;
} Int64Item;

static R_xlen_t validate_vector(SEXP x)
{
    if (CHAR_BIT != 8 || sizeof(double) != 8 || sizeof(int64_t) != 8)
        Rf_error("integer64 requires eight-byte double and int64_t storage.");
    if (TYPEOF(x) != REALSXP || !Rf_inherits(x, "integer64") ||
        Rf_getAttrib(x, R_DimSymbol) != R_NilValue)
        Rf_error("Expected an integer64 vector with double storage and no dimensions.");
    return XLENGTH(x);
}

static int64_t read_value(const double *storage, R_xlen_t i)
{
    int64_t value;
    memcpy(&value, storage + i, sizeof(value));
    return value;
}

static void check_interrupt(R_xlen_t i)
{
    if (i % 65536 == 0) R_CheckUserInterrupt();
}

static int precedes(Int64Item a, Int64Item b, int decreasing)
{
    if (a.value == b.value) return a.index < b.index;
    if (a.value == INT64_MIN) return 0;
    if (b.value == INT64_MIN) return 1;
    return decreasing ? a.value > b.value : a.value < b.value;
}

/* Bottom-up merge sort retains input order for ties in either direction. */
static Int64Item *sorted_items(SEXP x, R_xlen_t n, int decreasing)
{
    if ((uintmax_t)n > (uintmax_t)(SIZE_MAX / sizeof(Int64Item)))
        Rf_error("integer64 sort scratch space is too large.");
    Int64Item *items = (Int64Item *)R_alloc((size_t)n, sizeof(Int64Item));
    Int64Item *scratch = (Int64Item *)R_alloc((size_t)n, sizeof(Int64Item));
    const double *storage = REAL(x);
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        items[i].value = read_value(storage, i);
        items[i].index = i;
    }
    for (R_xlen_t width = 1; width < n;) {
        R_CheckUserInterrupt();
        for (R_xlen_t left = 0; left < n;) {
            R_xlen_t mid = left + (width < n - left ? width : n - left);
            R_xlen_t right = mid + (width < n - mid ? width : n - mid);
            R_xlen_t a = left, b = mid;
            for (R_xlen_t out = left; out < right; ++out) {
                check_interrupt(out);
                if (b == right || (a < mid && precedes(items[a], items[b], decreasing)))
                    scratch[out] = items[a++];
                else
                    scratch[out] = items[b++];
            }
            left = right;
        }
        Int64Item *swap = items;
        items = scratch;
        scratch = swap;
        if (width >= n - width) break;
        width += width;
    }
    return items;
}

SEXP C_jdv_int64_is_na(SEXP x)
{
    R_xlen_t n = validate_vector(x);
    SEXP out = PROTECT(Rf_allocVector(LGLSXP, n));
    const double *storage = REAL(x);
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        LOGICAL(out)[i] = read_value(storage, i) == INT64_MIN;
    }
    UNPROTECT(1);
    return out;
}

SEXP C_jdv_int64_values(SEXP x)
{
    R_xlen_t n = validate_vector(x);
    SEXP out = PROTECT(Rf_allocVector(STRSXP, n));
    const double *storage = REAL(x);
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        int64_t value = read_value(storage, i);
        if (value == INT64_MIN) {
            SET_STRING_ELT(out, i, NA_STRING);
        } else {
            char buffer[22];
            int length = snprintf(buffer, sizeof(buffer), "%" PRId64, value);
            if (length < 0 || (size_t)length >= sizeof(buffer))
                Rf_error("Could not format an integer64 value.");
            SET_STRING_ELT(out, i, Rf_mkChar(buffer));
        }
    }
    UNPROTECT(1);
    return out;
}

SEXP C_jdv_int64_rank(SEXP x)
{
    R_xlen_t n = validate_vector(x);
    int small = n <= INT_MAX;
    SEXP out = PROTECT(Rf_allocVector(small ? INTSXP : REALSXP, n));
    Int64Item *items = sorted_items(x, n, 0);
    R_xlen_t rank = 0;
    int64_t previous = INT64_MIN;
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        int missing = items[i].value == INT64_MIN;
        if (!missing && (rank == 0 || items[i].value != previous)) ++rank;
        previous = items[i].value;
        if (small) INTEGER(out)[items[i].index] = missing ? NA_INTEGER : (int)rank;
        else REAL(out)[items[i].index] = missing ? NA_REAL : (double)rank;
    }
    UNPROTECT(1);
    return out;
}

SEXP C_jdv_int64_order(SEXP x, SEXP decreasing)
{
    R_xlen_t n = validate_vector(x);
    if (TYPEOF(decreasing) != LGLSXP || XLENGTH(decreasing) != 1 ||
        LOGICAL(decreasing)[0] == NA_LOGICAL)
        Rf_error("decreasing must be one nonmissing logical value.");
    int small = n <= INT_MAX;
    SEXP out = PROTECT(Rf_allocVector(small ? INTSXP : REALSXP, n));
    Int64Item *items = sorted_items(x, n, LOGICAL(decreasing)[0]);
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        if (small) INTEGER(out)[i] = (int)(items[i].index + 1);
        else REAL(out)[i] = (double)(items[i].index + 1);
    }
    UNPROTECT(1);
    return out;
}

/* Canonical decimal queries deliberately reject numeric coercion. */
static int64_t parse_decimal(SEXP x)
{
    if (TYPEOF(x) != STRSXP || XLENGTH(x) != 1 || Rf_isObject(x) ||
        Rf_getAttrib(x, R_DimSymbol) != R_NilValue || STRING_ELT(x, 0) == NA_STRING)
        Rf_error("Expected one nonmissing plain decimal string.");
    const char *text = CHAR(STRING_ELT(x, 0));
    int negative = *text == '-';
    const char *digits = text + negative;
    if (!*digits || (*digits == '0' && (digits[1] || negative)))
        Rf_error("Expected a canonical decimal string.");
    uint64_t magnitude = 0;
    uint64_t limit = (uint64_t)INT64_MAX + (uint64_t)negative;
    for (const char *p = digits; *p; ++p) {
        if (*p < '0' || *p > '9') Rf_error("Expected a canonical decimal string.");
        unsigned int digit = (unsigned int)(*p - '0');
        if (magnitude > (limit - digit) / 10)
            Rf_error("Decimal string is outside the integer64 range.");
        magnitude = magnitude * 10 + digit;
    }
    if (negative && magnitude == (uint64_t)INT64_MAX + 1)
        Rf_error("INT64_MIN is reserved for integer64 NA.");
    return negative ? -(int64_t)magnitude : (int64_t)magnitude;
}

static SEXP compare_range(SEXP x, int64_t lower, int64_t upper)
{
    R_xlen_t n = validate_vector(x);
    SEXP out = PROTECT(Rf_allocVector(LGLSXP, n));
    const double *storage = REAL(x);
    for (R_xlen_t i = 0; i < n; ++i) {
        check_interrupt(i);
        int64_t value = read_value(storage, i);
        LOGICAL(out)[i] = value != INT64_MIN && value >= lower && value <= upper;
    }
    UNPROTECT(1);
    return out;
}

SEXP C_jdv_int64_eq(SEXP x, SEXP value)
{
    int64_t parsed = parse_decimal(value);
    return compare_range(x, parsed, parsed);
}

SEXP C_jdv_int64_between(SEXP x, SEXP lower, SEXP upper)
{
    int64_t low = parse_decimal(lower), high = parse_decimal(upper);
    if (low > high) Rf_error("lower must not exceed upper.");
    return compare_range(x, low, high);
}
