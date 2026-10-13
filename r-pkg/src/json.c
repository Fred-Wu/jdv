#include <R.h>
#include <Rinternals.h>
#include <R_ext/Arith.h>
#include <R_ext/Utils.h>
#include <ctype.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cjson/cJSON.h"

typedef struct {
    cJSON *tree;
} parse_state;

typedef struct {
    char *data;
    size_t size;
    size_t capacity;
    size_t limit;
    size_t work_limit;
    size_t work_used;
    size_t tree_charge;
    cJSON *tree;
    char *printed;
    size_t printed_capacity;
    int streamed_columns;
} output_state;

typedef struct {
    output_state *output;
    SEXP value;
} encode_request;

static void parse_cleanup(void *data, Rboolean jump)
{
    parse_state *state = (parse_state *)data;
    (void)jump;
    cJSON_Delete(state->tree);
    state->tree = NULL;
}

static void work_charge(output_state *state, size_t amount);

static void output_cleanup(void *data, Rboolean jump)
{
    output_state *state = (output_state *)data;
    (void)jump;
    free(state->data);
    state->data = NULL;
    cJSON_Delete(state->tree);
    state->tree = NULL;
    free(state->printed);
    state->printed = NULL;
}

static int valid_utf8(const unsigned char *s, size_t n)
{
    size_t i = 0;
    while (i < n) {
        if (s[i] < 0x80) {
            if (s[i] == 0) return 0;
            ++i;
        } else if (s[i] >= 0xc2 && s[i] <= 0xdf) {
            if (i + 1 >= n || (s[i + 1] & 0xc0) != 0x80) return 0;
            i += 2;
        } else if (s[i] >= 0xe0 && s[i] <= 0xef) {
            if (i + 2 >= n || (s[i + 1] & 0xc0) != 0x80 || (s[i + 2] & 0xc0) != 0x80) return 0;
            if (s[i] == 0xe0 && s[i + 1] < 0xa0) return 0;
            if (s[i] == 0xed && s[i + 1] >= 0xa0) return 0;
            i += 3;
        } else if (s[i] >= 0xf0 && s[i] <= 0xf4) {
            if (i + 3 >= n || (s[i + 1] & 0xc0) != 0x80 ||
                (s[i + 2] & 0xc0) != 0x80 || (s[i + 3] & 0xc0) != 0x80) return 0;
            if (s[i] == 0xf0 && s[i + 1] < 0x90) return 0;
            if (s[i] == 0xf4 && s[i + 1] >= 0x90) return 0;
            i += 4;
        } else {
            return 0;
        }
    }
    return 1;
}

/* Keep this validator length-aware: malformed trailing multibyte sequences
 * must not read past the R or cJSON string allocation. */
static int valid_utf8_cstr(const char *s)
{
    return valid_utf8((const unsigned char *)s, strlen(s));
}

static int tree_valid(const cJSON *node, int depth, size_t *nodes)
{
    const cJSON *child;
    const cJSON *other;
    if (depth > 128 || ++*nodes > 100000) return 0;
    if (cJSON_IsNumber(node) && !R_FINITE(node->valuedouble)) return 0;
    if (cJSON_IsString(node)) {
        if (!node->valuestring || !valid_utf8_cstr(node->valuestring)) return 0;
    }
    if (cJSON_IsObject(node)) {
        size_t members = 0;
        for (child = node->child; child; child = child->next) {
            if (++members > 1024) return 0;
            if (!child->string || !valid_utf8_cstr(child->string)) return 0;
            for (other = child->next; other; other = other->next) {
                if (other->string && strcmp(child->string, other->string) == 0) return 0;
            }
        }
    }
    for (child = node->child; child; child = child->next) {
        if (!tree_valid(child, depth + 1, nodes)) return 0;
    }
    return 1;
}

typedef struct {
    const unsigned char *text;
    size_t length;
    size_t at;
    size_t nodes;
} json_cursor;

static void skip_space(json_cursor *cursor)
{
    while (cursor->at < cursor->length) {
        unsigned char c = cursor->text[cursor->at];
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
        ++cursor->at;
    }
}

static int hex_value(unsigned char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int read_hex4(json_cursor *cursor, unsigned int *value)
{
    unsigned int out = 0;
    for (int i = 0; i < 4; ++i) {
        if (cursor->at >= cursor->length) return 0;
        int digit = hex_value(cursor->text[cursor->at++]);
        if (digit < 0) return 0;
        out = (out << 4) | (unsigned int)digit;
    }
    *value = out;
    return 1;
}

static int parse_json_string(json_cursor *cursor)
{
    if (cursor->at >= cursor->length || cursor->text[cursor->at++] != '"') return 0;
    while (cursor->at < cursor->length) {
        unsigned char c = cursor->text[cursor->at++];
        if (c == '"') return 1;
        if (c < 0x20) return 0;
        if (c != '\\') continue;
        if (cursor->at >= cursor->length) return 0;
        c = cursor->text[cursor->at++];
        if (c == '"' || c == '\\' || c == '/' || c == 'b' || c == 'f' ||
            c == 'n' || c == 'r' || c == 't') continue;
        if (c != 'u') return 0;
        unsigned int code;
        if (!read_hex4(cursor, &code) || code == 0) return 0;
        if (code >= 0xd800 && code <= 0xdbff) {
            unsigned int low;
            if (cursor->at + 2 > cursor->length || cursor->text[cursor->at++] != '\\' ||
                cursor->text[cursor->at++] != 'u' || !read_hex4(cursor, &low) ||
                low < 0xdc00 || low > 0xdfff) return 0;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return 0;
        }
    }
    return 0;
}

static int parse_json_number(json_cursor *cursor)
{
    size_t at = cursor->at;
    if (at < cursor->length && cursor->text[at] == '-') ++at;
    if (at >= cursor->length) return 0;
    if (cursor->text[at] == '0') {
        ++at;
        if (at < cursor->length && isdigit(cursor->text[at])) return 0;
    } else {
        if (cursor->text[at] < '1' || cursor->text[at] > '9') return 0;
        while (at < cursor->length && isdigit(cursor->text[at])) ++at;
    }
    if (at < cursor->length && cursor->text[at] == '.') {
        ++at;
        size_t first = at;
        while (at < cursor->length && isdigit(cursor->text[at])) ++at;
        if (at == first) return 0;
    }
    if (at < cursor->length && (cursor->text[at] == 'e' || cursor->text[at] == 'E')) {
        ++at;
        if (at < cursor->length && (cursor->text[at] == '+' || cursor->text[at] == '-')) ++at;
        size_t first = at;
        while (at < cursor->length && isdigit(cursor->text[at])) ++at;
        if (at == first) return 0;
    }
    cursor->at = at;
    return 1;
}

static int parse_json_value(json_cursor *cursor, int depth);

static int parse_json_array(json_cursor *cursor, int depth)
{
    ++cursor->at;
    skip_space(cursor);
    if (cursor->at < cursor->length && cursor->text[cursor->at] == ']') {
        ++cursor->at;
        return 1;
    }
    for (;;) {
        if (!parse_json_value(cursor, depth + 1)) return 0;
        skip_space(cursor);
        if (cursor->at >= cursor->length) return 0;
        if (cursor->text[cursor->at] == ']') { ++cursor->at; return 1; }
        if (cursor->text[cursor->at++] != ',') return 0;
        skip_space(cursor);
    }
}

static int parse_json_object(json_cursor *cursor, int depth)
{
    size_t members = 0;
    ++cursor->at;
    skip_space(cursor);
    if (cursor->at < cursor->length && cursor->text[cursor->at] == '}') {
        ++cursor->at;
        return 1;
    }
    for (;;) {
        if (++members > 1024) return 0;
        if (!parse_json_string(cursor)) return 0;
        skip_space(cursor);
        if (cursor->at >= cursor->length || cursor->text[cursor->at++] != ':') return 0;
        skip_space(cursor);
        if (!parse_json_value(cursor, depth + 1)) return 0;
        skip_space(cursor);
        if (cursor->at >= cursor->length) return 0;
        if (cursor->text[cursor->at] == '}') { ++cursor->at; return 1; }
        if (cursor->text[cursor->at++] != ',') return 0;
        skip_space(cursor);
    }
}

static int parse_json_value(json_cursor *cursor, int depth)
{
    size_t remaining;
    const unsigned char *text;
    if (depth > 128 || cursor->at >= cursor->length || ++cursor->nodes > 100000) return 0;
    text = cursor->text + cursor->at;
    remaining = cursor->length - cursor->at;
    if (*text == '{') return parse_json_object(cursor, depth);
    if (*text == '[') return parse_json_array(cursor, depth);
    if (*text == '"') return parse_json_string(cursor);
    if (*text == '-' || isdigit(*text)) return parse_json_number(cursor);
    if (remaining >= 4 && memcmp(text, "true", 4) == 0) { cursor->at += 4; return 1; }
    if (remaining >= 5 && memcmp(text, "false", 5) == 0) { cursor->at += 5; return 1; }
    if (remaining >= 4 && memcmp(text, "null", 4) == 0) { cursor->at += 4; return 1; }
    return 0;
}

static int json_string_is_id(const unsigned char *text, size_t start, size_t end)
{
    size_t at = start + 1;
    char decoded[3];
    size_t n = 0;
    while (at + 1 < end && n < sizeof(decoded)) {
        unsigned char c = text[at++];
        if (c == '\\') {
            if (at >= end - 1) return 0;
            c = text[at++];
            if (c == 'u') {
                unsigned int code = 0;
                for (int i = 0; i < 4; ++i) {
                    if (at >= end - 1) return 0;
                    int digit = hex_value(text[at++]);
                    if (digit < 0) return 0;
                    code = (code << 4) | (unsigned int)digit;
                }
                if (code > 0x7f) return 0;
                c = (unsigned char)code;
            } else if (c != '"' && c != '\\' && c != '/') {
                return 0;
            }
        }
        decoded[n++] = (char)c;
    }
    return at == end - 1 && n == 2 && decoded[0] == 'i' && decoded[1] == 'd';
}

/* cJSON stores numbers as doubles. Reject request IDs whose raw JSON number
 * is fractional, exponential, or outside the exact integer range before that
 * conversion can round them into a different ID. */
static int safe_top_level_numeric_id(const unsigned char *text, size_t length)
{
    json_cursor cursor = {text, length, 0, 0};
    skip_space(&cursor);
    if (cursor.at >= length || text[cursor.at++] != '{') return 1;
    skip_space(&cursor);
    if (cursor.at < length && text[cursor.at] == '}') return 1;
    for (;;) {
        size_t key_start = cursor.at;
        if (!parse_json_string(&cursor)) return 0;
        size_t key_end = cursor.at;
        int is_id = json_string_is_id(text, key_start, key_end);
        skip_space(&cursor);
        if (cursor.at >= length || text[cursor.at++] != ':') return 0;
        skip_space(&cursor);
        size_t value_start = cursor.at;
        if (!parse_json_value(&cursor, 1)) return 0;
        size_t value_end = cursor.at;
        if (is_id && value_start < value_end &&
            (text[value_start] == '-' || isdigit(text[value_start]))) {
            uint64_t magnitude = 0;
            size_t digit = value_start + (text[value_start] == '-' ? 1 : 0);
            if (digit == value_end) return 0;
            for (; digit < value_end; ++digit) {
                unsigned char c = text[digit];
                if (c < '0' || c > '9') return 0;
                uint64_t value = (uint64_t)(c - '0');
                if (magnitude >
                    (UINT64_C(9007199254740991) - value) / UINT64_C(10)) return 0;
                magnitude = magnitude * 10 + value;
                if (magnitude > UINT64_C(9007199254740991)) return 0;
            }
        }
        skip_space(&cursor);
        if (cursor.at >= length) return 0;
        if (text[cursor.at] == '}') return 1;
        if (text[cursor.at++] != ',') return 0;
        skip_space(&cursor);
    }
}

static int strict_json_document(const unsigned char *text, size_t length)
{
    json_cursor cursor = {text, length, 0, 0};
    skip_space(&cursor);
    if (!parse_json_value(&cursor, 0)) return 0;
    skip_space(&cursor);
    return cursor.at == length;
}

static void set_class(SEXP x, const char *name)
{
    SEXP cls = PROTECT(Rf_mkString(name));
    Rf_classgets(x, cls);
    UNPROTECT(1);
}

static SEXP parse_node(const cJSON *node)
{
    const cJSON *child;
    int n = 0;
    if (cJSON_IsNull(node)) return R_NilValue;
    if (cJSON_IsTrue(node)) return ScalarLogical(1);
    if (cJSON_IsFalse(node)) return ScalarLogical(0);
    if (cJSON_IsNumber(node)) return ScalarReal(node->valuedouble);
    if (cJSON_IsString(node)) {
        SEXP ch = PROTECT(Rf_mkCharLenCE(node->valuestring, (int)strlen(node->valuestring), CE_UTF8));
        SEXP out = Rf_ScalarString(ch);
        UNPROTECT(1);
        return out;
    }
    for (child = node->child; child; child = child->next) ++n;
    if (cJSON_IsArray(node)) {
        SEXP out = PROTECT(Rf_allocVector(VECSXP, n));
        int i = 0;
        for (child = node->child; child; child = child->next) {
            SET_VECTOR_ELT(out, i++, parse_node(child));
        }
        if (n == 0) set_class(out, "jdv_json_array");
        UNPROTECT(1);
        return out;
    }
    if (cJSON_IsObject(node)) {
        SEXP out = PROTECT(Rf_allocVector(VECSXP, n));
        SEXP names = PROTECT(Rf_allocVector(STRSXP, n));
        int i = 0;
        for (child = node->child; child; child = child->next) {
            SET_VECTOR_ELT(out, i, parse_node(child));
            SET_STRING_ELT(names, i++, Rf_mkCharCE(child->string, CE_UTF8));
        }
        Rf_setAttrib(out, R_NamesSymbol, names);
        set_class(out, "jdv_json_object");
        UNPROTECT(2);
        return out;
    }
    Rf_error("Invalid JSON value.");
    return R_NilValue;
}

static SEXP parse_body(void *data)
{
    parse_state *state = (parse_state *)data;
    return parse_node(state->tree);
}

SEXP C_jdv_json_parse(SEXP input, SEXP max_bytes)
{
    const char *text;
    const char *end;
    size_t length;
    size_t tree_nodes = 0;
    double limit;
    parse_state state;
    SEXP continuation;
    SEXP result;
    if (TYPEOF(input) != STRSXP || XLENGTH(input) != 1 || STRING_ELT(input, 0) == NA_STRING)
        Rf_error("JSON input must be one nonmissing string.");
    if (TYPEOF(max_bytes) != REALSXP || XLENGTH(max_bytes) != 1 || !R_FINITE(REAL(max_bytes)[0]) || REAL(max_bytes)[0] < 1)
        Rf_error("Invalid JSON byte limit.");
    limit = REAL(max_bytes)[0];
    text = CHAR(STRING_ELT(input, 0));
    length = (size_t)LENGTH(STRING_ELT(input, 0));
    if (length > limit) Rf_error("jdv_json_input_limit");
    if (memchr(text, '\0', length) != NULL) Rf_error("Invalid JSON input: embedded NUL.");
    if (!valid_utf8((const unsigned char *)text, length)) Rf_error("Invalid JSON input: malformed UTF-8.");
    if (!strict_json_document((const unsigned char *)text, length)) Rf_error("Invalid JSON input.");
    if (!safe_top_level_numeric_id((const unsigned char *)text, length)) Rf_error("Invalid JSON request id.");
    continuation = PROTECT(R_MakeUnwindCont());
    state.tree = cJSON_ParseWithLengthOpts(text, length + 1, &end, 1);
    if (!state.tree) Rf_error("Invalid JSON input.");
    while ((size_t)(end - text) < length && isspace((unsigned char)*end)) ++end;
    if ((size_t)(end - text) != length || !tree_valid(state.tree, 0, &tree_nodes)) {
        cJSON_Delete(state.tree);
        Rf_error("Invalid JSON input.");
    }
    result = R_UnwindProtect(parse_body, &state, parse_cleanup, &state, continuation);
    UNPROTECT(1);
    return result;
}

static void append_bytes(output_state *state, const char *data, size_t n)
{
    size_t needed;
    if (n > state->limit - state->size) Rf_error("jdv_json_output_limit");
    needed = state->size + n;
    if (needed > state->capacity) {
        size_t capacity = state->capacity ? state->capacity : 256;
        size_t old_charge = state->capacity + (state->data ? 1 : 0);
        while (capacity < needed) {
            if (capacity > state->limit / 2) { capacity = state->limit; break; }
            capacity *= 2;
        }
        if (capacity > SIZE_MAX - 1) Rf_error("jdv_json_work_limit");
        work_charge(state, capacity + 1);
        char *next = (char *)realloc(state->data, capacity + 1);
        if (!next) Rf_error("Unable to allocate JSON output.");
        state->work_used -= old_charge;
        state->data = next;
        state->capacity = capacity;
    }
    memcpy(state->data + state->size, data, n);
    state->size += n;
    state->data[state->size] = '\0';
}

static void append_char(output_state *state, char value)
{
    append_bytes(state, &value, 1);
}

static void work_charge(output_state *state, size_t amount)
{
    if (amount > state->work_limit - state->work_used)
        Rf_error("jdv_json_work_limit");
    state->work_used += amount;
}

static void tree_charge(output_state *state, size_t amount)
{
    work_charge(state, amount);
    state->tree_charge += amount;
}

static size_t checked_multiply(size_t value, size_t factor)
{
    if (factor != 0 && value > SIZE_MAX / factor)
        Rf_error("jdv_json_work_limit");
    return value * factor;
}

static size_t translated_string_charge(output_state *state, SEXP charsxp)
{
    size_t input_size = (size_t)LENGTH(charsxp);
    size_t charge = checked_multiply(input_size, 8);
    /* UTF-8 translation may coexist with the cJSON-owned copy. Four bytes per
     * input byte conservatively covers expansion; count both at peak. R's own
     * transient conversion scratch is outside this native work budget. */
    if (charge > SIZE_MAX - sizeof(cJSON) - 2)
        Rf_error("jdv_json_work_limit");
    return charge + sizeof(cJSON) + 2;
}

static int is_object(SEXP value)
{
    SEXP names = Rf_getAttrib(value, R_NamesSymbol);
    if (inherits(value, "jdv_json_object")) return 1;
    if (names != R_NilValue && XLENGTH(names) == XLENGTH(value)) return 1;
    return 0;
}

static cJSON *create_atomic(output_state *state, SEXP value, R_xlen_t i)
{
    switch (TYPEOF(value)) {
    case LGLSXP:
        if (LOGICAL(value)[i] == NA_LOGICAL) return cJSON_CreateNull();
        return LOGICAL(value)[i] ? cJSON_CreateTrue() : cJSON_CreateFalse();
    case INTSXP:
        if (INTEGER(value)[i] == NA_INTEGER) return cJSON_CreateNull();
        return cJSON_CreateNumber((double)INTEGER(value)[i]);
    case REALSXP:
        if (!R_FINITE(REAL(value)[i])) return cJSON_CreateNull();
        return cJSON_CreateNumber(REAL(value)[i]);
    case STRSXP:
        if (STRING_ELT(value, i) == NA_STRING) return cJSON_CreateNull();
        {
            SEXP charsxp = STRING_ELT(value, i);
            tree_charge(state, translated_string_charge(state, charsxp));
            const char *text = Rf_translateCharUTF8(charsxp);
            if (!valid_utf8_cstr(text)) Rf_error("Invalid UTF-8 in JSON output.");
            return cJSON_CreateString(text);
        }
    default:
        Rf_error("Unsupported JSON atomic type.");
    }
    return NULL;
}

static cJSON *new_container(output_state *state, SEXP value)
{
    tree_charge(state, sizeof(cJSON));
    return is_object(value) ? cJSON_CreateObject() : cJSON_CreateArray();
}

static void add_child(output_state *state, cJSON *parent, cJSON *child, const char *key)
{
    (void)state;
    if (!child) Rf_error("Unable to allocate JSON tree.");
    cJSON_bool ok = key ? cJSON_AddItemToObject(parent, key, child) : cJSON_AddItemToArray(parent, child);
    if (!ok) {
        cJSON_Delete(child);
        Rf_error("Unable to allocate JSON tree.");
    }
}

static void build_into(output_state *state, cJSON *parent, SEXP value, const char *key, int depth);

static void fill_container(output_state *state, cJSON *node, SEXP value, int depth)
{
    SEXP names = Rf_getAttrib(value, R_NamesSymbol);
    R_xlen_t n = XLENGTH(value);
    int object = cJSON_IsObject(node);
    for (R_xlen_t i = 0; i < n; ++i) {
        const char *key = NULL;
        if (object) {
            if (names == R_NilValue || STRING_ELT(names, i) == NA_STRING)
                Rf_error("JSON object names must be nonmissing strings.");
            SEXP charsxp = STRING_ELT(names, i);
            tree_charge(state, checked_multiply((size_t)LENGTH(charsxp), 4));
            key = Rf_translateCharUTF8(charsxp);
            if (!valid_utf8_cstr(key)) Rf_error("Invalid UTF-8 in JSON object name.");
            tree_charge(state, strlen(key) + 1);
        }
        build_into(state, node, VECTOR_ELT(value, i), key, depth + 1);
    }
}

static void build_into(output_state *state, cJSON *parent, SEXP value, const char *key, int depth)
{
    cJSON *node;
    R_xlen_t n;
    if (depth > 128) Rf_error("JSON output nesting exceeds the supported depth.");
    if (value == R_NilValue) {
        tree_charge(state, sizeof(cJSON));
        add_child(state, parent, cJSON_CreateNull(), key);
        return;
    }
    if (TYPEOF(value) == VECSXP) {
        node = new_container(state, value);
        if (!node) Rf_error("Unable to allocate JSON tree.");
        add_child(state, parent, node, key);
        fill_container(state, node, value, depth);
        return;
    }
    if (TYPEOF(value) != LGLSXP && TYPEOF(value) != INTSXP &&
        TYPEOF(value) != REALSXP && TYPEOF(value) != STRSXP)
        Rf_error("Unsupported JSON value.");
    n = XLENGTH(value);
    if (n == 1 && !inherits(value, "jdv_json_array")) {
        if (TYPEOF(value) != STRSXP || STRING_ELT(value, 0) == NA_STRING)
            tree_charge(state, sizeof(cJSON));
        node = create_atomic(state, value, 0);
        add_child(state, parent, node, key);
        return;
    }
    tree_charge(state, sizeof(cJSON));
    node = cJSON_CreateArray();
    if (!node) Rf_error("Unable to allocate JSON tree.");
    add_child(state, parent, node, key);
    for (R_xlen_t i = 0; i < n; ++i) {
        if (TYPEOF(value) != STRSXP || STRING_ELT(value, i) == NA_STRING)
            tree_charge(state, sizeof(cJSON));
        cJSON *item = create_atomic(state, value, i);
        add_child(state, node, item, NULL);
    }
}

static cJSON *build_tree(output_state *state, SEXP value)
{
    cJSON *tree;
    if (value == R_NilValue) {
        tree_charge(state, sizeof(cJSON));
        tree = cJSON_CreateNull();
    }
    else if (TYPEOF(value) == VECSXP) {
        tree = new_container(state, value);
        if (!tree) Rf_error("Unable to allocate JSON tree.");
        state->tree = tree;
        fill_container(state, tree, value, 0);
        return tree;
    } else {
        if (TYPEOF(value) != LGLSXP && TYPEOF(value) != INTSXP &&
            TYPEOF(value) != REALSXP && TYPEOF(value) != STRSXP)
            Rf_error("Unsupported JSON value.");
        if (XLENGTH(value) == 1 && !inherits(value, "jdv_json_array")) {
            if (TYPEOF(value) != STRSXP || STRING_ELT(value, 0) == NA_STRING)
                tree_charge(state, sizeof(cJSON));
            tree = create_atomic(state, value, 0);
        } else {
            tree_charge(state, sizeof(cJSON));
            tree = cJSON_CreateArray();
            if (!tree) Rf_error("Unable to allocate JSON tree.");
            state->tree = tree;
            for (R_xlen_t i = 0; i < XLENGTH(value); ++i) {
                if (TYPEOF(value) != STRSXP || STRING_ELT(value, i) == NA_STRING)
                    tree_charge(state, sizeof(cJSON));
                add_child(state, tree, create_atomic(state, value, i), NULL);
            }
            return tree;
        }
    }
    if (!tree) Rf_error("Unable to allocate JSON tree.");
    state->tree = tree;
    return tree;
}

static size_t size_add(output_state *state, size_t left, size_t right)
{
    if (right > SIZE_MAX - left) Rf_error("jdv_json_work_limit");
    return left + right;
}

static size_t printed_string_size(output_state *state, const char *text)
{
    size_t size = 2;
    const unsigned char *p = (const unsigned char *)text;
    while (*p) {
        size_t extra = (*p < 32) ? ((*p == '\b' || *p == '\f' || *p == '\n' ||
                                     *p == '\r' || *p == '\t') ? 1 : 5) :
                       ((*p == '"' || *p == '\\') ? 1 : 0);
        size = size_add(state, size, 1 + extra);
        ++p;
    }
    return size;
}

static size_t printed_number_size(output_state *state, const cJSON *node)
{
    unsigned char number_buffer[26] = {0};
    double test = 0.0;
    int length;
    double d = node->valuedouble;
    /* Adapted from cJSON's number-formatting logic in src/cjson/cJSON.c; see
     * the MIT notice in inst/COPYRIGHTS. Mirror its output length so the
     * buffer can be bounded without rejecting values that fit the JSON cap. */
    if (isnan(d) || isinf(d)) {
        length = snprintf((char *)number_buffer, sizeof(number_buffer), "null");
    } else if (d == (double)node->valueint) {
        length = snprintf((char *)number_buffer, sizeof(number_buffer), "%d", node->valueint);
    } else {
        length = snprintf((char *)number_buffer, sizeof(number_buffer), "%1.15g", d);
        if ((sscanf((char *)number_buffer, "%lg", &test) != 1) || test != d)
            length = snprintf((char *)number_buffer, sizeof(number_buffer), "%1.17g", d);
    }
    if (length < 0 || length > (int)(sizeof(number_buffer) - 1))
        Rf_error("Unable to size JSON number.");
    (void)state;
    return (size_t)length;
}

static size_t printed_node_size(output_state *state, const cJSON *node)
{
    size_t size = 0;
    const cJSON *child;
    if (cJSON_IsNull(node)) return 4;
    if (cJSON_IsTrue(node)) return 4;
    if (cJSON_IsFalse(node)) return 5;
    if (cJSON_IsNumber(node)) return printed_number_size(state, node);
    if (cJSON_IsString(node)) return printed_string_size(state, node->valuestring);
    if (cJSON_IsArray(node) || cJSON_IsObject(node)) {
        int object = cJSON_IsObject(node);
        size = 2;
        for (child = node->child; child; child = child->next) {
            if (child != node->child) size = size_add(state, size, 1);
            if (object) {
                if (!child->string) Rf_error("Invalid JSON object name.");
                size = size_add(state, size, printed_string_size(state, child->string));
                size = size_add(state, size, 1);
            }
            size = size_add(state, size, printed_node_size(state, child));
        }
        return size;
    }
    Rf_error("Unsupported cJSON node.");
    return 0;
}

static void emit_tree(output_state *state, SEXP value)
{
    size_t size;
    size_t capacity;
    void *vmax = vmaxget();
    state->tree = NULL;
    state->tree_charge = 0;
    (void)build_tree(state, value);
    size = printed_node_size(state, state->tree);
    if (size > state->limit - state->size) Rf_error("jdv_json_output_limit");
    if (size > (size_t)INT_MAX - 5) Rf_error("jdv_json_work_limit");
    capacity = size + 5;
    work_charge(state, capacity);
    state->printed = (char *)malloc(capacity);
    if (!state->printed) Rf_error("Unable to allocate JSON output.");
    state->printed_capacity = capacity;
    if (!cJSON_PrintPreallocated(state->tree, state->printed, (int)capacity, 0))
        Rf_error("Unable to print JSON tree.");
    char *end = (char *)memchr(state->printed, '\0', capacity);
    if (!end)
        Rf_error("JSON printer output is not terminated.");
    size_t actual_size = (size_t)(end - state->printed);
    if (actual_size > state->limit - state->size)
        Rf_error("jdv_json_output_limit");
    if (actual_size != size)
        Rf_error("JSON printer size estimate did not match its output.");
    append_bytes(state, state->printed, actual_size);
    free(state->printed);
    state->printed = NULL;
    state->work_used -= state->printed_capacity;
    state->printed_capacity = 0;
    cJSON_Delete(state->tree);
    state->tree = NULL;
    state->work_used -= state->tree_charge;
    state->tree_charge = 0;
    vmaxset(vmax);
}

static void emit_value(output_state *state, SEXP value, int depth)
{
    if (depth > 128) Rf_error("JSON output nesting exceeds the supported depth.");
    if (TYPEOF(value) != VECSXP || value == R_NilValue) {
        emit_tree(state, value);
        return;
    }
    if (is_object(value)) {
        SEXP names = Rf_getAttrib(value, R_NamesSymbol);
        append_char(state, '{');
        for (R_xlen_t i = 0; i < XLENGTH(value); ++i) {
            SEXP name = STRING_ELT(names, i);
            const char *key = CHAR(name);
            int is_columns = LENGTH(name) == 7 && memcmp(key, "columns", 7) == 0;
            SEXP key_value = PROTECT(Rf_ScalarString(name));
            if (i) append_char(state, ',');
            emit_tree(state, key_value);
            UNPROTECT(1);
            append_char(state, ':');
            if (is_columns && TYPEOF(VECTOR_ELT(value, i)) == VECSXP &&
                !is_object(VECTOR_ELT(value, i))) {
                SEXP columns = VECTOR_ELT(value, i);
                append_char(state, '[');
                for (R_xlen_t j = 0; j < XLENGTH(columns); ++j) {
                    if (j) append_char(state, ',');
                    emit_tree(state, VECTOR_ELT(columns, j));
                }
                append_char(state, ']');
                state->streamed_columns++;
            } else {
                emit_value(state, VECTOR_ELT(value, i), depth + 1);
            }
        }
        append_char(state, '}');
        return;
    }
    int has_objects = 0;
    for (R_xlen_t i = 0; i < XLENGTH(value); ++i) {
        SEXP item = VECTOR_ELT(value, i);
        if (TYPEOF(item) == VECSXP && item != R_NilValue && is_object(item)) {
            has_objects = 1;
            break;
        }
    }
    if (!has_objects) {
        emit_tree(state, value);
        return;
    }
    append_char(state, '[');
    for (R_xlen_t i = 0; i < XLENGTH(value); ++i) {
        if (i) append_char(state, ',');
        emit_value(state, VECTOR_ELT(value, i), depth + 1);
    }
    append_char(state, ']');
}

static SEXP encode_body(void *data)
{
    encode_request *request = (encode_request *)data;
    output_state *state = request->output;
    emit_value(state, request->value, 0);
    work_charge(state, checked_multiply(state->size + 1, 2) + 256);
    return Rf_ScalarString(Rf_mkCharLenCE(state->data ? state->data : "", (int)state->size, CE_UTF8));
}

SEXP C_jdv_json_encode(SEXP object, SEXP max_bytes, SEXP max_work_bytes)
{
    output_state state;
    encode_request request;
    double limit;
    double work_limit;
    SEXP continuation;
    SEXP result;
    memset(&state, 0, sizeof(state));
    if (TYPEOF(max_bytes) != REALSXP || XLENGTH(max_bytes) != 1 || !R_FINITE(REAL(max_bytes)[0]) || REAL(max_bytes)[0] < 1)
        Rf_error("Invalid JSON byte limit.");
    if (TYPEOF(max_work_bytes) != REALSXP || XLENGTH(max_work_bytes) != 1 ||
        !R_FINITE(REAL(max_work_bytes)[0]) || REAL(max_work_bytes)[0] < 1)
        Rf_error("Invalid JSON work byte limit.");
    limit = REAL(max_bytes)[0];
    if (limit > 1000000000.0) limit = 1000000000.0;
    work_limit = REAL(max_work_bytes)[0];
    if (work_limit > (double)(SIZE_MAX / 2)) work_limit = (double)(SIZE_MAX / 2);
    state.limit = (size_t)limit;
    state.work_limit = (size_t)work_limit;
    request.output = &state;
    request.value = object;
    continuation = PROTECT(R_MakeUnwindCont());
    result = R_UnwindProtect(encode_body, &request, output_cleanup, &state, continuation);
    UNPROTECT(1);
    return result;
}
