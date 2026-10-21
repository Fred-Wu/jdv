#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>
#include <Rversion.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#if R_VERSION >= R_Version(4, 6, 0)
#define JDV_HAS_R46_API 1
#else
#define JDV_HAS_R46_API 0
#endif

static const char *tree_type_name(SEXPTYPE type)
{
    switch (type) {
    case NILSXP: return "null";
    case SYMSXP: return "symbol";
    case LISTSXP: return "pairlist";
    case CLOSXP: return "closure";
    case ENVSXP: return "environment";
    case PROMSXP: return "promise";
    case LANGSXP: return "language";
    case SPECIALSXP: return "special";
    case BUILTINSXP: return "builtin";
    case CHARSXP: return "char";
    case LGLSXP: return "logical";
    case INTSXP: return "integer";
    case REALSXP: return "double";
    case CPLXSXP: return "complex";
    case STRSXP: return "character";
    case DOTSXP: return "dots";
    case VECSXP: return "list";
    case EXPRSXP: return "expression";
    case BCODESXP: return "bytecode";
    case EXTPTRSXP: return "externalptr";
    case WEAKREFSXP: return "weakref";
    case RAWSXP: return "raw";
    case S4SXP: return "s4";
    default: return "unknown";
    }
}

static int tree_vector_type(SEXPTYPE type)
{
    return type == LGLSXP || type == INTSXP || type == REALSXP ||
        type == CPLXSXP || type == STRSXP || type == RAWSXP ||
        type == VECSXP || type == EXPRSXP;
}

static int pairlist_type(SEXPTYPE type)
{
    return type == LISTSXP || type == DOTSXP;
}

static double pairlist_length(SEXP x)
{
    SEXP slow = x;
    SEXP fast = x;
    R_xlen_t count = 0;
    R_xlen_t walked = 0;

    while (pairlist_type(TYPEOF(fast))) {
        if (walked++ >= 5000) return -1.0;
        fast = CDR(fast);
        if (!pairlist_type(TYPEOF(fast))) break;
        if (walked++ >= 5000) return -1.0;
        fast = CDR(fast);
        slow = CDR(slow);
        if (fast == slow) return -1.0;
    }

    while (pairlist_type(TYPEOF(x))) {
        if (count >= 10000 || count == R_XLEN_T_MAX) return -1.0;
        count++;
        x = CDR(x);
    }
    return (double)count;
}

static SEXP named_list(int size, const char **names)
{
    SEXP out = PROTECT(Rf_allocVector(VECSXP, size));
    SEXP out_names = PROTECT(Rf_allocVector(STRSXP, size));
    for (int i = 0; i < size; i++) {
        SET_VECTOR_ELT(out, i, R_NilValue);
        SET_STRING_ELT(out_names, i, Rf_mkChar(names[i]));
    }
    Rf_setAttrib(out, R_NamesSymbol, out_names);
    UNPROTECT(2);
    return out;
}

static SEXP tree_child_result(const char *status, SEXP value)
{
    const char *names[] = {"status", "value"};
    PROTECT(value);
    SEXP out = PROTECT(named_list(2, names));
    SEXP status_value = PROTECT(Rf_mkString(status));
    SET_VECTOR_ELT(out, 0, status_value);
    SET_VECTOR_ELT(out, 1, value);
    UNPROTECT(3);
    return out;
}

static SEXP tree_pairlist_element(SEXP x, R_xlen_t index)
{
    double count = pairlist_length(x);
    if (count < 0.0 || (double)index >= count)
        return R_UnboundValue;
    while (index-- > 0) x = CDR(x);
    return CAR(x);
}

static SEXP tree_atomic_element(SEXP x, R_xlen_t index)
{
    SEXP out = PROTECT(Rf_allocVector(TYPEOF(x), 1));
    switch (TYPEOF(x)) {
    case LGLSXP:
        LOGICAL(out)[0] = LOGICAL_ELT(x, index);
        break;
    case INTSXP:
        INTEGER(out)[0] = INTEGER_ELT(x, index);
        break;
    case REALSXP:
        REAL(out)[0] = REAL_ELT(x, index);
        break;
    case CPLXSXP:
        COMPLEX(out)[0] = COMPLEX_ELT(x, index);
        break;
    case STRSXP:
        SET_STRING_ELT(out, 0, STRING_ELT(x, index));
        break;
    case RAWSXP:
        RAW(out)[0] = RAW_ELT(x, index);
        break;
    default:
        UNPROTECT(1);
        return R_NilValue;
    }
    /* Preserve semantic metadata used by classed scalar formatters. */
#if JDV_HAS_R46_API
    SEXP attribute_names = PROTECT(R_getAttribNames(x));
    for (R_xlen_t i = 0; i < XLENGTH(attribute_names); i++) {
        SEXP name = STRING_ELT(attribute_names, i);
        if (name == NA_STRING) continue;
        SEXP tag = Rf_installChar(name);
        if (tag == R_NamesSymbol || tag == R_DimSymbol ||
            tag == R_DimNamesSymbol || tag == R_TspSymbol) {
            continue;
        }
        Rf_setAttrib(out, tag, Rf_getAttrib(x, tag));
    }
    UNPROTECT(1);
#else
    for (SEXP node = ATTRIB(x); node != R_NilValue; node = CDR(node)) {
        SEXP tag = TAG(node);
        if (tag == R_NamesSymbol || tag == R_DimSymbol ||
            tag == R_DimNamesSymbol || tag == R_TspSymbol) {
            continue;
        }
        Rf_setAttrib(out, tag, CAR(node));
    }
#endif
    UNPROTECT(1);
    return out;
}

static SEXP tree_binding_result(SEXP env, SEXP name)
{
    if (TYPEOF(env) != ENVSXP || TYPEOF(name) != STRSXP || XLENGTH(name) != 1 ||
        STRING_ELT(name, 0) == NA_STRING) {
        Rf_error("invalid environment binding lookup");
    }
    SEXP symbol = Rf_installChar(STRING_ELT(name, 0));
#if JDV_HAS_R46_API
    R_BindingType_t type = R_GetBindingType(symbol, env);
    switch (type) {
    case R_BindingTypeValue:
    case R_BindingTypeForced: {
        SEXP value = R_getVarEx(symbol, env, FALSE, R_NilValue);
        return tree_child_result(type == R_BindingTypeValue ? "value" : "forced",
                                 value);
    }
    case R_BindingTypeUnbound:
        return tree_child_result("unbound", R_NilValue);
    case R_BindingTypeMissing:
        return tree_child_result("missing", R_NilValue);
    case R_BindingTypeDelayed:
        return tree_child_result("delayed", R_NilValue);
    case R_BindingTypeActive:
        return tree_child_result("active", R_NilValue);
    }
    return tree_child_result("opaque", R_NilValue);
#else
    if (!R_existsVarInFrame(env, symbol))
        return tree_child_result("unbound", R_NilValue);
    if (R_BindingIsActive(symbol, env))
        return tree_child_result("active", R_NilValue);
    return tree_child_result("opaque", R_NilValue);
#endif
}

SEXP C_jdv_tree_info(SEXP x)
{
    const char *names[] = {
        "type", "length", "class", "altrep", "reference", "storage_type",
        "is_matrix", "is_array"
    };
    SEXP out = PROTECT(named_list(8, names));
    SEXP type = PROTECT(Rf_mkString(Rf_isS4(x) ? "s4" : tree_type_name(TYPEOF(x))));
    double length = 0.0;
    if (tree_vector_type(TYPEOF(x))) {
        length = (double)XLENGTH(x);
    } else if (pairlist_type(TYPEOF(x))) {
        length = pairlist_length(x);
    }
    SEXP length_sexp = PROTECT(Rf_ScalarReal(length));
    SEXP klass_source = Rf_getAttrib(x, R_ClassSymbol);
    SEXP klass = R_NilValue;
    if (TYPEOF(klass_source) == STRSXP) {
        R_xlen_t class_length = XLENGTH(klass_source);
        if (class_length > 16) class_length = 16;
        klass = PROTECT(Rf_allocVector(STRSXP, class_length));
        for (R_xlen_t i = 0; i < class_length; i++)
            SET_STRING_ELT(klass, i, STRING_ELT(klass_source, i));
    } else {
        PROTECT(klass);
    }
    SEXP altrep = PROTECT(Rf_ScalarLogical(ALTREP(x)));
    SEXPTYPE sexptype = TYPEOF(x);
    SEXP dim = Rf_getAttrib(x, R_DimSymbol);
    int is_array = TYPEOF(dim) == INTSXP && XLENGTH(dim) > 0;
    int is_matrix = is_array && XLENGTH(dim) == 2;
    SEXP matrix_flag = PROTECT(Rf_ScalarLogical(is_matrix));
    SEXP array_flag = PROTECT(Rf_ScalarLogical(is_array));
    SEXP reference = PROTECT(Rf_ScalarLogical(
        Rf_isS4(x) || sexptype == VECSXP || sexptype == EXPRSXP ||
        pairlist_type(sexptype) || sexptype == ENVSXP || sexptype == EXTPTRSXP ||
        sexptype == CLOSXP || sexptype == LANGSXP));
    SEXP storage_type = PROTECT(Rf_mkString(tree_type_name(sexptype)));
    SET_VECTOR_ELT(out, 0, type);
    SET_VECTOR_ELT(out, 1, length_sexp);
    SET_VECTOR_ELT(out, 2, klass);
    SET_VECTOR_ELT(out, 3, altrep);
    SET_VECTOR_ELT(out, 4, reference);
    SET_VECTOR_ELT(out, 5, storage_type);
    SET_VECTOR_ELT(out, 6, matrix_flag);
    SET_VECTOR_ELT(out, 7, array_flag);
    UNPROTECT(9);
    return out;
}

SEXP C_jdv_tree_child(SEXP x, SEXP kind, SEXP index, SEXP name)
{
    if (TYPEOF(kind) != STRSXP || XLENGTH(kind) != 1 || STRING_ELT(kind, 0) == NA_STRING)
        Rf_error("invalid tree child kind");
    const char *kind_text = CHAR(STRING_ELT(kind, 0));
    if (strcmp(kind_text, "index") == 0) {
        double number = Rf_asReal(index);
        if (!R_FINITE(number) || number < 1.0 || number != floor(number) ||
            number > (double)R_XLEN_T_MAX) {
            Rf_error("invalid tree child index");
        }
        R_xlen_t position = (R_xlen_t)number - 1;
        SEXPTYPE type = TYPEOF(x);
        SEXP value = R_NilValue;
        if (type == VECSXP || type == EXPRSXP) {
            if (position >= XLENGTH(x)) return tree_child_result("unbound", R_NilValue);
            value = VECTOR_ELT(x, position);
        } else if (tree_vector_type(type) && type != VECSXP && type != EXPRSXP) {
            if (position >= XLENGTH(x)) return tree_child_result("unbound", R_NilValue);
            value = tree_atomic_element(x, position);
        } else if (pairlist_type(type)) {
            value = tree_pairlist_element(x, position);
            if (value == R_UnboundValue) return tree_child_result("unbound", R_NilValue);
        } else {
            Rf_error("value does not support index children");
        }
        if (value == R_MissingArg) return tree_child_result("missing", R_NilValue);
        if (TYPEOF(value) == PROMSXP) return tree_child_result("promise", R_NilValue);
        return tree_child_result("value", value);
    }
    if (strcmp(kind_text, "binding") == 0) {
        return tree_binding_result(x, name);
    }
    if (strcmp(kind_text, "attr") == 0 || strcmp(kind_text, "slot") == 0) {
        if (TYPEOF(name) != STRSXP || XLENGTH(name) != 1 || STRING_ELT(name, 0) == NA_STRING)
            Rf_error("invalid tree attribute name");
        const char *attribute_name = CHAR(STRING_ELT(name, 0));
        if (strcmp(attribute_name, ".Data") == 0 && Rf_isS4(x))
            return tree_child_result("s4_data_opaque", R_NilValue);
        SEXP symbol = Rf_installChar(STRING_ELT(name, 0));
#if JDV_HAS_R46_API
        int present = R_hasAttrib(x, symbol);
#else
        int present = 0;
        for (SEXP node = ATTRIB(x); node != R_NilValue; node = CDR(node)) {
            if (TAG(node) == symbol) {
                present = 1;
                break;
            }
        }
#endif
        if (!present) return tree_child_result("unbound", R_NilValue);
        SEXP value = Rf_getAttrib(x, symbol);
        if (value == R_MissingArg || value == R_UnboundValue ||
            (TYPEOF(value) == SYMSXP &&
             value == Rf_install("\001NULL\001")))
            value = R_NilValue;
        if (TYPEOF(value) == PROMSXP) return tree_child_result("promise", R_NilValue);
        return tree_child_result("value", value);
    }
    Rf_error("unsupported tree child kind");
    return R_NilValue;
}

SEXP C_jdv_tree_same(SEXP x, SEXP y)
{
    return Rf_ScalarLogical(x == y);
}

SEXP C_jdv_tree_scalar_text(SEXP x)
{
    if (!tree_vector_type(TYPEOF(x)) || TYPEOF(x) == VECSXP ||
        TYPEOF(x) == EXPRSXP || XLENGTH(x) != 1) {
        Rf_error("expected one atomic tree scalar");
    }
    SEXP value = PROTECT(tree_atomic_element(x, 0));
    SEXP charsxp = PROTECT(Rf_asChar(value));
    SEXP text = PROTECT(Rf_ScalarString(charsxp));
    UNPROTECT(3);
    return text;
}

SEXP C_jdv_tree_names(SEXP x)
{
#if JDV_HAS_R46_API
    return R_getAttribNames(x);
#else
    SEXP attrs = ATTRIB(x);
    R_xlen_t count = 0;
    for (SEXP node = attrs; node != R_NilValue; node = CDR(node)) {
        if (count == R_XLEN_T_MAX) Rf_error("too many attributes");
        count++;
    }
    SEXP out = PROTECT(Rf_allocVector(STRSXP, count));
    R_xlen_t i = 0;
    for (SEXP node = attrs; node != R_NilValue; node = CDR(node)) {
        SEXP tag = TAG(node);
        SET_STRING_ELT(out, i++, tag == R_NilValue ? R_BlankString : PRINTNAME(tag));
    }
    UNPROTECT(1);
    return out;
#endif
}

SEXP C_jdv_tree_vector_names(SEXP x, SEXP start, SEXP count)
{
    SEXP names = Rf_getAttrib(x, R_NamesSymbol);
    if (TYPEOF(names) != STRSXP) return R_NilValue;
    double first = Rf_asReal(start);
    double n = Rf_asReal(count);
    if (!R_FINITE(first) || !R_FINITE(n) || first < 1 || n < 0 ||
        first != floor(first) || n != floor(n) || n > 500 ||
        first + n - 1 > XLENGTH(names))
        Rf_error("invalid vector name page");
    SEXP out = PROTECT(Rf_allocVector(STRSXP, (R_xlen_t)n));
    for (R_xlen_t i = 0; i < (R_xlen_t)n; i++)
        SET_STRING_ELT(out, i, STRING_ELT(names, (R_xlen_t)first - 1 + i));
    UNPROTECT(1);
    return out;
}

/* Copy a contiguous range of an atomic vector into a plain vector of the same
 * type with no attributes. Only the requested range is read, through the
 * region accessors, so ALTREP values never materialize a full data pointer. */
SEXP C_jdv_tree_vector_page(SEXP x, SEXP start, SEXP count)
{
    SEXPTYPE type = TYPEOF(x);
    if (!tree_vector_type(type) || type == VECSXP || type == EXPRSXP)
        Rf_error("expected an atomic vector");
    double first = Rf_asReal(start);
    double n = Rf_asReal(count);
    if (!R_FINITE(first) || !R_FINITE(n) || first < 1 || n < 0 ||
        first != floor(first) || n != floor(n) || n > 500 ||
        first + n - 1 > (double)XLENGTH(x))
        Rf_error("invalid vector page");
    R_xlen_t from = (R_xlen_t)first - 1;
    R_xlen_t size = (R_xlen_t)n;
    SEXP out = PROTECT(Rf_allocVector(type, size));
    if (size > 0) {
        switch (type) {
        case LGLSXP:
            LOGICAL_GET_REGION(x, from, size, LOGICAL(out));
            break;
        case INTSXP:
            INTEGER_GET_REGION(x, from, size, INTEGER(out));
            break;
        case REALSXP:
            REAL_GET_REGION(x, from, size, REAL(out));
            break;
        case CPLXSXP:
            COMPLEX_GET_REGION(x, from, size, COMPLEX(out));
            break;
        case RAWSXP:
            RAW_GET_REGION(x, from, size, RAW(out));
            break;
        case STRSXP:
            for (R_xlen_t i = 0; i < size; i++)
                SET_STRING_ELT(out, i, STRING_ELT(x, from + i));
            break;
        default:
            break;
        }
    }
    UNPROTECT(1);
    return out;
}

/* Binding tracking helpers. The environment is held through a public weak
 * reference so tracking never keeps a local frame alive by itself. */
SEXP C_jdv_weakref_make(SEXP env)
{
    if (TYPEOF(env) != ENVSXP) Rf_error("expected an environment");
    return R_MakeWeakRef(env, R_NilValue, R_NilValue, FALSE);
}

SEXP C_jdv_weakref_key(SEXP ref)
{
    if (TYPEOF(ref) != WEAKREFSXP) Rf_error("expected a weak reference");
    return R_WeakRefKey(ref);
}

/* Read one binding without evaluating it. The result has the status of the
 * binding ("gone" once the environment was collected) and, for Value and
 * Forced bindings, the stored object itself. */
SEXP C_jdv_binding_read(SEXP ref, SEXP name)
{
    if (TYPEOF(ref) != WEAKREFSXP) Rf_error("expected a weak reference");
    SEXP env = PROTECT(R_WeakRefKey(ref));
    if (TYPEOF(env) != ENVSXP) {
        UNPROTECT(1);
        return tree_child_result("gone", R_NilValue);
    }
    SEXP out = tree_binding_result(env, name);
    UNPROTECT(1);
    return out;
}
