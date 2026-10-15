/* Independent C Data producer for parent-offset page regression coverage. */
#include <nanoarrow/r.h>
#include <R_ext/Rdynload.h>
#include <R_ext/Visibility.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

static void schema_release(struct ArrowSchema *schema) {
  if (schema->dictionary != NULL) {
    if (schema->dictionary->release != NULL)
      schema->dictionary->release(schema->dictionary);
    free(schema->dictionary);
  }
  if (schema->children != NULL) {
    for (int64_t i = 0; i < schema->n_children; i++) {
      if (schema->children[i] != NULL) {
        if (schema->children[i]->release != NULL)
          schema->children[i]->release(schema->children[i]);
        free(schema->children[i]);
      }
    }
    free(schema->children);
  }
  free((void *)schema->format);
  free((void *)schema->name);
  schema->release = NULL;
}

static void array_release(struct ArrowArray *array) {
  if (array->children != NULL) {
    for (int64_t i = 0; i < array->n_children; i++) {
      if (array->children[i] != NULL) {
        if (array->children[i]->release != NULL)
          array->children[i]->release(array->children[i]);
        free(array->children[i]);
      }
    }
    free(array->children);
  }
  if (array->dictionary != NULL) {
    if (array->dictionary->release != NULL)
      array->dictionary->release(array->dictionary);
    free(array->dictionary);
  }
  if (array->buffers != NULL) {
    for (int64_t i = 0; i < array->n_buffers; i++)
      free((void *)array->buffers[i]);
  }
  free((void *)array->buffers);
  array->release = NULL;
}

typedef struct {
  int position;
  int mode;
} pagefixture_state;

static char *pagefixture_strdup(const char *value) {
  size_t size = strlen(value) + 1;
  char *copy = (char *)malloc(size);
  if (copy != NULL) memcpy(copy, value, size);
  return copy;
}

static void stream_release(struct ArrowArrayStream *stream) {
  free(stream->private_data);
  stream->private_data = NULL;
  stream->release = NULL;
}

static int get_schema(struct ArrowArrayStream *stream,
                      struct ArrowSchema *schema) {
  pagefixture_state *state = (pagefixture_state *)stream->private_data;
  struct ArrowSchema *field;
  memset(schema, 0, sizeof(*schema));
  schema->format = pagefixture_strdup("+s");
  schema->name = pagefixture_strdup("");
  schema->release = schema_release;
  schema->n_children = 1;
  schema->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
  if (schema->format == NULL || schema->name == NULL ||
      schema->children == NULL) {
    free((void *)schema->format);
    free((void *)schema->name);
    free(schema->children);
    memset(schema, 0, sizeof(*schema));
    return ENOMEM;
  }
  schema->children[0] =
      (struct ArrowSchema *)calloc(1, sizeof(struct ArrowSchema));
  if (schema->children[0] == NULL) return ENOMEM;
  field = schema->children[0];
  field->format = pagefixture_strdup(state->mode == 0 ? "i" :
                                     (state->mode == 1 ? "+vl" :
                                      (state->mode == 2 || state->mode == 4
                                           ? "+L"
                                           : "+s")));
  field->name = pagefixture_strdup(
      state->mode == 0 ? "value" :
      (state->mode == 1 ? "unsupported" :
       (state->mode == 2 ? "items" :
        (state->mode == 4 ? "items" : "group"))));
  field->flags = ARROW_FLAG_NULLABLE;
  field->release = schema_release;
  if (state->mode == 1) {
    field->n_children = 1;
    field->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
    if (field->children == NULL) return ENOMEM;
    field->children[0] =
        (struct ArrowSchema *)calloc(1, sizeof(struct ArrowSchema));
    if (field->children[0] == NULL) return ENOMEM;
    field->children[0]->format = pagefixture_strdup("c");
    field->children[0]->name = pagefixture_strdup("item");
    field->children[0]->flags = ARROW_FLAG_NULLABLE;
    field->children[0]->release = schema_release;
    field->children[0]->dictionary =
        (struct ArrowSchema *)calloc(1, sizeof(struct ArrowSchema));
    if (field->children[0]->dictionary == NULL) return ENOMEM;
    field->children[0]->dictionary->format = pagefixture_strdup("u");
    field->children[0]->dictionary->name = pagefixture_strdup("");
    field->children[0]->dictionary->flags = ARROW_FLAG_NULLABLE;
    field->children[0]->dictionary->release = schema_release;
  } else if (state->mode == 2) {
    struct ArrowSchema *item;
    field->n_children = 1;
    field->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
    if (field->children == NULL) return ENOMEM;
    item = (struct ArrowSchema *)calloc(1, sizeof(struct ArrowSchema));
    if (item == NULL) return ENOMEM;
    field->children[0] = item;
    item->format = pagefixture_strdup("c");
    item->name = pagefixture_strdup("item");
    item->flags = ARROW_FLAG_NULLABLE;
    item->release = schema_release;
    item->dictionary = (struct ArrowSchema *)calloc(1, sizeof(struct ArrowSchema));
    if (item->dictionary == NULL) return ENOMEM;
    item->dictionary->format = pagefixture_strdup("u");
    item->dictionary->name = pagefixture_strdup("");
    item->dictionary->flags = ARROW_FLAG_NULLABLE;
    item->dictionary->release = schema_release;
  } else if (state->mode == 3 || state->mode == 5) {
    struct ArrowSchema *child;
    field->n_children = 1;
    field->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
    if (field->children == NULL) return ENOMEM;
    child = (struct ArrowSchema *)calloc(1, sizeof(*child));
    if (child == NULL) return ENOMEM;
    field->children[0] = child;
    child->format = pagefixture_strdup(state->mode == 5 ? "vu" : "u");
    child->name = pagefixture_strdup("text");
    child->flags = ARROW_FLAG_NULLABLE;
    child->release = schema_release;
  } else if (state->mode == 4) {
    struct ArrowSchema *item, *text;
    field->n_children = 1;
    field->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
    if (field->children == NULL) return ENOMEM;
    item = (struct ArrowSchema *)calloc(1, sizeof(*item));
    if (item == NULL) return ENOMEM;
    field->children[0] = item;
    item->format = pagefixture_strdup("+s");
    item->name = pagefixture_strdup("item");
    item->flags = ARROW_FLAG_NULLABLE;
    item->release = schema_release;
    item->n_children = 1;
    item->children = (struct ArrowSchema **)calloc(1, sizeof(void *));
    if (item->children == NULL) return ENOMEM;
    text = (struct ArrowSchema *)calloc(1, sizeof(*text));
    if (text == NULL) return ENOMEM;
    item->children[0] = text;
    text->format = pagefixture_strdup("u");
    text->name = pagefixture_strdup("text");
    text->flags = ARROW_FLAG_NULLABLE;
    text->release = schema_release;
  }
  return 0;
}

static int get_next(struct ArrowArrayStream *stream, struct ArrowArray *array) {
  pagefixture_state *state = (pagefixture_state *)stream->private_data;
  struct ArrowArray *child;
  const void **root_buffers;
  const void **child_buffers;
  int32_t *values;
  memset(array, 0, sizeof(*array));
  if (state->mode >= 3 && state->mode <= 5) {
    struct ArrowArray *field, *text;
    const void **root_buffers, **field_buffers, **text_buffers;
    if (state->position++ > 0) return 0;
    array->length = state->mode == 3 ? 1 : 1;
    array->offset = state->mode == 3 ? 1 : 0;
    array->n_buffers = 1;
    root_buffers = (const void **)calloc(1, sizeof(void *));
    array->buffers = root_buffers;
    array->n_children = 1;
    array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    array->release = array_release;
    if (root_buffers == NULL || array->children == NULL) return ENOMEM;

    field = (struct ArrowArray *)calloc(1, sizeof(*field));
    if (field == NULL) return ENOMEM;
    array->children[0] = field;
    field->release = array_release;

    if (state->mode == 4) {
      int64_t *offsets;
      field->length = 1;
      field->n_buffers = 2;
      field_buffers = (const void **)calloc(2, sizeof(void *));
      field->buffers = field_buffers;
      field->n_children = 1;
      field->children = (struct ArrowArray **)calloc(1, sizeof(void *));
      if (field_buffers == NULL || field->children == NULL) return ENOMEM;
      offsets = (int64_t *)malloc(2 * sizeof(int64_t));
      if (offsets == NULL) return ENOMEM;
      offsets[0] = 0;
      offsets[1] = 1;
      field_buffers[1] = offsets;
      {
        struct ArrowArray *item = (struct ArrowArray *)calloc(1, sizeof(*item));
        const void **item_buffers;
        uint8_t *validity;
        int32_t *item_offsets;
        char *item_data;
        if (item == NULL) return ENOMEM;
        field->children[0] = item;
        item->length = 1;
        item->n_buffers = 1;
        item_buffers = (const void **)calloc(1, sizeof(void *));
        item->buffers = item_buffers;
        item->n_children = 1;
        item->children = (struct ArrowArray **)calloc(1, sizeof(void *));
        item->release = array_release;
        if (item_buffers == NULL || item->children == NULL) return ENOMEM;
        validity = (uint8_t *)calloc(1, sizeof(uint8_t));
        if (validity == NULL) return ENOMEM;
        item_buffers[0] = validity;
        text = (struct ArrowArray *)calloc(1, sizeof(*text));
        if (text == NULL) return ENOMEM;
        item->children[0] = text;
        text->length = 1;
        text->n_buffers = 3;
        text_buffers = (const void **)calloc(3, sizeof(void *));
        text->buffers = text_buffers;
        text->release = array_release;
        if (text_buffers == NULL) return ENOMEM;
        item_offsets = (int32_t *)malloc(2 * sizeof(int32_t));
        item_data = (char *)malloc(4096);
        if (item_offsets == NULL || item_data == NULL) return ENOMEM;
        item_offsets[0] = 0;
        item_offsets[1] = 4096;
        memset(item_data, 'x', 4096);
        text_buffers[1] = item_offsets;
        text_buffers[2] = item_data;
      }
      return 0;
    }

    if (state->mode == 5) {
      struct {
        int32_t size;
        uint8_t data[12];
      } *view;
      int64_t *variadic_sizes;
      uint8_t *validity;
      field->length = 1;
      field->n_buffers = 1;
      field_buffers = (const void **)calloc(1, sizeof(void *));
      field->buffers = field_buffers;
      field->release = array_release;
      field->n_children = 1;
      field->children = (struct ArrowArray **)calloc(1, sizeof(void *));
      if (field_buffers == NULL || field->children == NULL) return ENOMEM;
      validity = (uint8_t *)calloc(1, sizeof(uint8_t));
      if (validity == NULL) return ENOMEM;
      field_buffers[0] = validity;
      text = (struct ArrowArray *)calloc(1, sizeof(*text));
      if (text == NULL) return ENOMEM;
      field->children[0] = text;
      text->length = 1;
      text->n_buffers = 3;
      text_buffers = (const void **)calloc(3, sizeof(void *));
      text->buffers = text_buffers;
      text->release = array_release;
      if (text_buffers == NULL) return ENOMEM;
      view = calloc(1, sizeof(*view));
      variadic_sizes = (int64_t *)calloc(1, sizeof(int64_t));
      if (view == NULL || variadic_sizes == NULL) return ENOMEM;
      view->size = 1;
      view->data[0] = 'x';
      text_buffers[1] = view;
      text_buffers[2] = variadic_sizes;
      return 0;
    }

    field->length = 2;
    field->n_buffers = 1;
    field_buffers = (const void **)calloc(1, sizeof(void *));
    field->buffers = field_buffers;
    field->n_children = 1;
    field->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    if (field_buffers == NULL || field->children == NULL) return ENOMEM;
    {
      uint8_t *validity = (uint8_t *)calloc(1, sizeof(uint8_t));
      int32_t *offsets;
      char *data;
      if (validity == NULL) return ENOMEM;
      validity[0] = 1;
      field_buffers[0] = validity;
      text = (struct ArrowArray *)calloc(1, sizeof(*text));
      if (text == NULL) return ENOMEM;
      field->children[0] = text;
      text->length = 2;
      text->n_buffers = 3;
      text_buffers = (const void **)calloc(3, sizeof(void *));
      text->buffers = text_buffers;
      text->release = array_release;
      if (text_buffers == NULL) return ENOMEM;
      offsets = (int32_t *)malloc(3 * sizeof(int32_t));
      data = (char *)malloc(4100);
      if (offsets == NULL || data == NULL) return ENOMEM;
      offsets[0] = 0;
      offsets[1] = 4;
      offsets[2] = 4100;
      memcpy(data, "okay", 4);
      memset(data + 4, 'x', 4096);
      text_buffers[1] = offsets;
      text_buffers[2] = data;
    }
    return 0;
  }
  if (state->mode == 1) {
    struct ArrowArray *list_array, *item_array, *dictionary;
    const void **list_buffers, **item_buffers, **dictionary_buffers;
    int32_t *offsets, *sizes, *dictionary_offsets;
    int8_t *indices;
    char *dictionary_data;
    if (state->position++ > 0) return 0;
    array->length = 1;
    array->n_buffers = 1;
    array->buffers = (const void **)calloc(1, sizeof(void *));
    array->n_children = 1;
    array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    array->release = array_release;
    if (array->buffers == NULL || array->children == NULL) return ENOMEM;
    list_array = (struct ArrowArray *)calloc(1, sizeof(*list_array));
    if (list_array == NULL) return ENOMEM;
    array->children[0] = list_array;
    list_array->length = 1;
    list_array->n_buffers = 3;
    list_buffers = (const void **)calloc(3, sizeof(void *));
    list_array->buffers = list_buffers;
    list_array->n_children = 1;
    list_array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    list_array->release = array_release;
    if (list_buffers == NULL || list_array->children == NULL) return ENOMEM;
    offsets = (int32_t *)malloc(sizeof(int32_t));
    sizes = (int32_t *)malloc(sizeof(int32_t));
    if (offsets == NULL || sizes == NULL) return ENOMEM;
    offsets[0] = 0;
    sizes[0] = 1;
    list_buffers[1] = offsets;
    list_buffers[2] = sizes;

    item_array = (struct ArrowArray *)calloc(1, sizeof(*item_array));
    if (item_array == NULL) return ENOMEM;
    list_array->children[0] = item_array;
    item_array->length = 1;
    item_array->n_buffers = 2;
    item_buffers = (const void **)calloc(2, sizeof(void *));
    item_array->buffers = item_buffers;
    item_array->release = array_release;
    dictionary = (struct ArrowArray *)calloc(1, sizeof(*dictionary));
    if (item_buffers == NULL || dictionary == NULL) return ENOMEM;
    item_array->dictionary = dictionary;
    indices = (int8_t *)malloc(sizeof(int8_t));
    if (indices == NULL) return ENOMEM;
    indices[0] = 0;
    item_buffers[1] = indices;

    dictionary->length = 1;
    dictionary->n_buffers = 3;
    dictionary_buffers = (const void **)calloc(3, sizeof(void *));
    dictionary->buffers = dictionary_buffers;
    dictionary->release = array_release;
    if (dictionary_buffers == NULL) return ENOMEM;
    dictionary_offsets = (int32_t *)malloc(2 * sizeof(int32_t));
    dictionary_data = (char *)malloc(4096);
    if (dictionary_offsets == NULL || dictionary_data == NULL) return ENOMEM;
    dictionary_offsets[0] = 0;
    dictionary_offsets[1] = 4096;
    memset(dictionary_data, 'x', 4096);
    dictionary_buffers[1] = dictionary_offsets;
    dictionary_buffers[2] = dictionary_data;
    return 0;
  }
  if (state->mode == 2) {
    struct ArrowArray *list_array, *item_array, *dictionary;
    const void **list_buffers, **item_buffers, **dictionary_buffers;
    int64_t *offsets;
    int8_t *indices;
    int32_t *dictionary_offsets;
    char *dictionary_data;
    if (state->position++ > 0) return 0;
    array->length = 1;
    array->n_buffers = 1;
    array->buffers = (const void **)calloc(1, sizeof(void *));
    array->n_children = 1;
    array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    array->release = array_release;
    if (array->buffers == NULL || array->children == NULL) return ENOMEM;
    list_array = (struct ArrowArray *)calloc(1, sizeof(*list_array));
    if (list_array == NULL) return ENOMEM;
    array->children[0] = list_array;
    list_array->length = 1;
    list_array->n_buffers = 2;
    list_buffers = (const void **)calloc(2, sizeof(void *));
    list_array->buffers = list_buffers;
    list_array->n_children = 1;
    list_array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
    list_array->release = array_release;
    if (list_buffers == NULL || list_array->children == NULL) return ENOMEM;
    offsets = (int64_t *)malloc(2 * sizeof(int64_t));
    if (offsets == NULL) return ENOMEM;
    offsets[0] = 0;
    offsets[1] = 2;
    list_buffers[1] = offsets;

    item_array = (struct ArrowArray *)calloc(1, sizeof(*item_array));
    if (item_array == NULL) return ENOMEM;
    list_array->children[0] = item_array;
    item_array->length = 2;
    item_array->n_buffers = 2;
    item_buffers = (const void **)calloc(2, sizeof(void *));
    item_array->buffers = item_buffers;
    item_array->release = array_release;
    dictionary = (struct ArrowArray *)calloc(1, sizeof(*dictionary));
    if (item_buffers == NULL || dictionary == NULL) return ENOMEM;
    item_array->dictionary = dictionary;
    indices = (int8_t *)malloc(2 * sizeof(int8_t));
    if (indices == NULL) return ENOMEM;
    indices[0] = 0;
    indices[1] = 1;
    item_buffers[1] = indices;

    dictionary->length = 2;
    dictionary->n_buffers = 3;
    dictionary_buffers = (const void **)calloc(3, sizeof(void *));
    dictionary->buffers = dictionary_buffers;
    dictionary->release = array_release;
    if (dictionary_buffers == NULL) return ENOMEM;
    dictionary_offsets = (int32_t *)malloc(3 * sizeof(int32_t));
    dictionary_data = (char *)malloc(9);
    if (dictionary_offsets == NULL || dictionary_data == NULL) {
      free(dictionary_offsets);
      free(dictionary_data);
      return ENOMEM;
    }
    dictionary_offsets[0] = 0;
    dictionary_offsets[1] = 5;
    dictionary_offsets[2] = 9;
    memcpy(dictionary_data, "alphabeta", 9);
    dictionary_buffers[1] = dictionary_offsets;
    dictionary_buffers[2] = dictionary_data;
    return 0;
  }
  if (state->position++ > 0) return 0;

  array->length = 2;
  array->offset = 1;
  array->n_buffers = 1;
  root_buffers = (const void **)calloc(1, sizeof(void *));
  array->buffers = root_buffers;
  array->n_children = 1;
  array->children = (struct ArrowArray **)calloc(1, sizeof(void *));
  child = (struct ArrowArray *)calloc(1, sizeof(struct ArrowArray));
  if (root_buffers == NULL || array->children == NULL || child == NULL)
    return ENOMEM;
  array->children[0] = child;

  child->length = 3;
  child->n_buffers = 2;
  child_buffers = (const void **)calloc(2, sizeof(void *));
  values = (int32_t *)malloc(3 * sizeof(int32_t));
  if (child_buffers == NULL || values == NULL) {
    free((void *)child_buffers);
    free(values);
    return ENOMEM;
  }
  values[0] = 10;
  values[1] = 20;
  values[2] = 30;
  child_buffers[1] = values;
  child->buffers = child_buffers;
  child->release = array_release;
  array->release = array_release;
  return 0;
}

static const char *get_last_error(struct ArrowArrayStream *stream) {
  (void)stream;
  return "page fixture error";
}

static SEXP pagefixture_init(SEXP pointer, SEXP mode) {
  struct ArrowArrayStream* stream;
  pagefixture_state *state;
  if (TYPEOF(pointer) != EXTPTRSXP) Rf_error("Expected a stream pointer.");
  stream = (struct ArrowArrayStream*)R_ExternalPtrAddr(pointer);
  if (stream == NULL || stream->release != NULL)
    Rf_error("Expected an empty stream pointer.");
  state = (pagefixture_state *)calloc(1, sizeof(*state));
  if (state == NULL) Rf_error("Could not allocate page fixture state.");
  state->mode = Rf_asInteger(mode);
  stream->get_schema = get_schema;
  stream->get_next = get_next;
  stream->get_last_error = get_last_error;
  stream->release = stream_release;
  stream->private_data = state;
  return pointer;
}

static const R_CallMethodDef methods[] = {
    {"pagefixture_init", (DL_FUNC)&pagefixture_init, 2},
    {NULL, NULL, 0}};

void attribute_visible R_init_pagefixture(DllInfo* dll) {
  R_registerRoutines(dll, NULL, methods, NULL, NULL);
  R_useDynamicSymbols(dll, FALSE);
  R_forceSymbols(dll, TRUE);
}
