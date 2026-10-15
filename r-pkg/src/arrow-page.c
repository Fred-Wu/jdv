#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <inttypes.h>
#include <R.h>
#include <Rinternals.h>
#include <R_ext/Utils.h>
#include "nanoarrow/nanoarrow_ipc.h"
#include "arrow-page.h"

static int append_dictionary(struct ArrowArray* out,
                             const struct ArrowArrayView* in,
                             struct ArrowError* error) {
  int64_t i;
  int code;
  if (in->dictionary != NULL) {
    if (out->dictionary == NULL) {
      ArrowErrorSet(error, "Destination dictionary storage is missing.");
      return EINVAL;
    }
    for (i = 0; i < in->dictionary->length; i++) {
      if ((i & 255) == 0) R_CheckUserInterrupt();
      struct ArrowArrayView one = *in->dictionary;
      one.offset += i;
      one.length = 1;
      one.null_count = ArrowArrayViewIsNull(in->dictionary, i) ? 1 : 0;
      code = ArrowArrayAppendStorageFromArrayView(out->dictionary, &one, error);
      if (code != NANOARROW_OK) return code;
    }
  }
  if (in->n_children != out->n_children) return EINVAL;
  for (i = 0; i < in->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    code = append_dictionary(out->children[i], in->children[i], error);
    if (code != NANOARROW_OK) return code;
  }
  return NANOARROW_OK;
}

static int append_value(struct ArrowArray* out,
                        const struct ArrowArrayView* in, int64_t index,
                        struct ArrowError* error) {
  int64_t i;
  int code;
  if (ArrowArrayViewIsNull(in, index))
    return ArrowArrayAppendNull(out, 1);
  switch (in->storage_type) {
    case NANOARROW_TYPE_STRUCT:
      if (in->n_children != out->n_children) return EINVAL;
      for (i = 0; i < in->n_children; i++) {
        if ((i & 255) == 0) R_CheckUserInterrupt();
        code = append_value(out->children[i], in->children[i],
                            in->offset + index, error);
        if (code != NANOARROW_OK) return code;
      }
      return ArrowArrayFinishElement(out);
    case NANOARROW_TYPE_LIST:
    case NANOARROW_TYPE_LARGE_LIST:
    case NANOARROW_TYPE_MAP: {
      int64_t begin = ArrowArrayViewListChildOffset(in, in->offset + index);
      int64_t end = ArrowArrayViewListChildOffset(in, in->offset + index + 1);
      if (begin < 0 || end < begin) {
        ArrowErrorSet(error, "Invalid list child offsets while copying page.");
        return EINVAL;
      }
      for (i = begin; i < end; i++) {
        if ((i & 255) == 0) R_CheckUserInterrupt();
        code = append_value(out->children[0], in->children[0], i, error);
        if (code != NANOARROW_OK) return code;
      }
      return ArrowArrayFinishElement(out);
    }
    case NANOARROW_TYPE_FIXED_SIZE_LIST: {
      int64_t child_begin = (in->offset + index) * in->layout.child_size_elements;
      int64_t child_end = child_begin + in->layout.child_size_elements;
      for (i = child_begin; i < child_end; i++) {
        if (((i - child_begin) & 255) == 0) R_CheckUserInterrupt();
        code = append_value(out->children[0], in->children[0], i, error);
        if (code != NANOARROW_OK) return code;
      }
      return ArrowArrayFinishElement(out);
    }
    default:
      break;
  }
  struct ArrowArrayView one = *in;
  one.offset += index;
  one.length = 1;
  one.null_count = ArrowArrayViewIsNull(in, index) ? 1 : 0;
  return ArrowArrayAppendStorageFromArrayView(out, &one, error);
}

static int schema_supported(const struct ArrowSchema* schema) {
  struct ArrowSchemaView view;
  struct ArrowError error;
  int64_t i;
  if (ArrowSchemaViewInit(&view, schema, &error) != NANOARROW_OK) return 0;
  if (view.type == NANOARROW_TYPE_DENSE_UNION ||
      view.type == NANOARROW_TYPE_SPARSE_UNION ||
      view.type == NANOARROW_TYPE_LIST_VIEW ||
      view.type == NANOARROW_TYPE_LARGE_LIST_VIEW ||
      (schema->dictionary && schema->dictionary->n_children > 0)) return 0;
  for (i = 0; i < schema->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    if (!schema_supported(schema->children[i])) return 0;
  }
  return 1;
}

static int normalize_views(struct ArrowSchema* schema, struct ArrowError* error) {
  struct ArrowSchemaView view;
  int64_t i;
  if (ArrowSchemaViewInit(&view, schema, error) != NANOARROW_OK) return EINVAL;
  if (view.type == NANOARROW_TYPE_STRING_VIEW)
    NANOARROW_RETURN_NOT_OK(ArrowSchemaSetType(schema, NANOARROW_TYPE_LARGE_STRING));
  else if (view.type == NANOARROW_TYPE_BINARY_VIEW)
    NANOARROW_RETURN_NOT_OK(ArrowSchemaSetType(schema, NANOARROW_TYPE_LARGE_BINARY));
  for (i = 0; i < schema->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    NANOARROW_RETURN_NOT_OK(normalize_views(schema->children[i], error));
  }
  if (schema->dictionary)
    NANOARROW_RETURN_NOT_OK(normalize_views(schema->dictionary, error));
  return NANOARROW_OK;
}

static int make_page_schema(const struct ArrowSchema* source,
                            struct ArrowSchema* out, int64_t* n_supported,
                            struct ArrowError* error) {
  int64_t i, j = 0;
  int code;
  *n_supported = 0;
  for (i = 0; i < source->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    if (schema_supported(source->children[i])) (*n_supported)++;
  }
  ArrowSchemaInit(out);
  code = ArrowSchemaSetTypeStruct(out, *n_supported);
  if (code) return code;
  out->flags = source->flags;
  if (source->name) NANOARROW_RETURN_NOT_OK(ArrowSchemaSetName(out, source->name));
  if (source->metadata) NANOARROW_RETURN_NOT_OK(ArrowSchemaSetMetadata(out, source->metadata));
  for (i = 0; i < source->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    if (!schema_supported(source->children[i])) continue;
    code = ArrowSchemaDeepCopy(source->children[i], out->children[j]);
    if (code) return code;
    code = normalize_views(out->children[j], error);
    if (code) return code;
    j++;
  }
  return NANOARROW_OK;
}

static int add_bytes(int64_t* total, int64_t bytes, int64_t limit) {
  if (bytes < 0 || *total > limit || bytes > limit - *total) return EOVERFLOW;
  *total += bytes;
  return NANOARROW_OK;
}

static int add_scaled_bytes(int64_t* total, int64_t count, int64_t width,
                            int64_t limit) {
  if (count < 0 || width < 0 || (width > 0 && count > INT64_MAX / width))
    return EOVERFLOW;
  return add_bytes(total, count * width, limit);
}

static int estimate_empty(const struct ArrowArrayView* view, int64_t count,
                          int64_t* total, int64_t limit,
                          struct ArrowError* error) {
  int64_t i;
  int64_t width = 0;
  if (count < 0) return EINVAL;
  NANOARROW_RETURN_NOT_OK(add_bytes(total, count, limit));
  switch (view->storage_type) {
    case NANOARROW_TYPE_STRING:
    case NANOARROW_TYPE_BINARY:
      return add_scaled_bytes(total, count, 4, limit);
    case NANOARROW_TYPE_LARGE_STRING:
    case NANOARROW_TYPE_LARGE_BINARY:
    case NANOARROW_TYPE_STRING_VIEW:
    case NANOARROW_TYPE_BINARY_VIEW:
    case NANOARROW_TYPE_LIST:
    case NANOARROW_TYPE_MAP:
      return add_scaled_bytes(total, count, 8, limit);
    case NANOARROW_TYPE_LARGE_LIST:
    case NANOARROW_TYPE_LIST_VIEW:
    case NANOARROW_TYPE_LARGE_LIST_VIEW:
      return add_scaled_bytes(total, count, 16, limit);
    case NANOARROW_TYPE_FIXED_SIZE_BINARY:
      width = view->layout.element_size_bits[1] / 8;
      return add_scaled_bytes(total, count, width, limit);
    case NANOARROW_TYPE_STRUCT:
      for (i = 0; i < view->n_children; i++) {
        if ((i & 255) == 0) R_CheckUserInterrupt();
        NANOARROW_RETURN_NOT_OK(estimate_empty(view->children[i], count,
                                                total, limit, error));
      }
      return NANOARROW_OK;
    case NANOARROW_TYPE_FIXED_SIZE_LIST:
      if (view->layout.child_size_elements > 0 &&
          count > INT64_MAX / view->layout.child_size_elements)
        return EOVERFLOW;
      return estimate_empty(view->children[0],
                            count * view->layout.child_size_elements,
                            total, limit, error);
    default:
      if (view->layout.element_size_bits[1] > 0) {
        width = (view->layout.element_size_bits[1] + 7) / 8;
        return add_scaled_bytes(total, count, width, limit);
      }
      return NANOARROW_OK;
  }
}

static int estimate_null(const struct ArrowArrayView* view, int64_t* total,
                         int64_t limit, struct ArrowError* error) {
  int64_t i;
  switch (view->storage_type) {
    case NANOARROW_TYPE_STRUCT:
      NANOARROW_RETURN_NOT_OK(add_bytes(total, 1, limit));
      for (i = 0; i < view->n_children; i++)
        NANOARROW_RETURN_NOT_OK(estimate_empty(view->children[i], 1, total,
                                                limit, error));
      return NANOARROW_OK;
    case NANOARROW_TYPE_FIXED_SIZE_LIST:
      NANOARROW_RETURN_NOT_OK(add_bytes(total, 1, limit));
      return estimate_empty(view->children[0], view->layout.child_size_elements,
                            total, limit, error);
    default:
      return estimate_empty(view, 1, total, limit, error);
  }
}

static int estimate_value(const struct ArrowArrayView* view, int64_t index,
                          int64_t* total, int64_t limit,
                          struct ArrowError* error) {
  int64_t i;
  if (ArrowArrayViewIsNull(view, index))
    return estimate_null(view, total, limit, error);
  if (view->storage_type == NANOARROW_TYPE_STRUCT) {
    NANOARROW_RETURN_NOT_OK(add_bytes(total, 1, limit));
    for (i = 0; i < view->n_children; i++) {
      if ((i & 255) == 0) R_CheckUserInterrupt();
      NANOARROW_RETURN_NOT_OK(estimate_value(view->children[i],
                                              view->offset + index, total,
                                              limit, error));
    }
    return NANOARROW_OK;
  }
  NANOARROW_RETURN_NOT_OK(add_bytes(total, 1, limit));
  switch (view->storage_type) {
    case NANOARROW_TYPE_STRING:
    case NANOARROW_TYPE_BINARY:
    case NANOARROW_TYPE_LARGE_STRING:
    case NANOARROW_TYPE_LARGE_BINARY:
    case NANOARROW_TYPE_STRING_VIEW:
    case NANOARROW_TYPE_BINARY_VIEW:
    case NANOARROW_TYPE_FIXED_SIZE_BINARY: {
      int64_t len = 0, offsets = 8;
      if (view->storage_type == NANOARROW_TYPE_FIXED_SIZE_BINARY)
        len = view->layout.element_size_bits[1] / 8;
      else
        len = ArrowArrayViewGetStringUnsafe(view, index).size_bytes;
      if (view->storage_type == NANOARROW_TYPE_STRING ||
          view->storage_type == NANOARROW_TYPE_BINARY) offsets = 4;
      if (len > INT64_MAX - offsets) return EOVERFLOW;
      NANOARROW_RETURN_NOT_OK(add_bytes(total, len + offsets, limit));
      return NANOARROW_OK;
    }
    case NANOARROW_TYPE_LIST:
    case NANOARROW_TYPE_LARGE_LIST:
    case NANOARROW_TYPE_MAP:
    case NANOARROW_TYPE_LIST_VIEW:
    case NANOARROW_TYPE_LARGE_LIST_VIEW: {
      int64_t begin, end;
      NANOARROW_RETURN_NOT_OK(add_bytes(total, 16, limit));
      begin = ArrowArrayViewListChildOffset(view, view->offset + index);
      if (view->storage_type == NANOARROW_TYPE_LIST_VIEW ||
          view->storage_type == NANOARROW_TYPE_LARGE_LIST_VIEW) {
        int64_t length = view->storage_type == NANOARROW_TYPE_LIST_VIEW
                             ? view->buffer_views[2].data.as_int32[view->offset + index]
                             : view->buffer_views[2].data.as_int64[view->offset + index];
        if (begin < 0 || length < 0 || begin > INT64_MAX - length) return EINVAL;
        end = begin + length;
      } else {
        end = ArrowArrayViewListChildOffset(view, view->offset + index + 1);
      }
      if (begin < 0 || end < begin) {
        ArrowErrorSet(error, "Invalid list child offsets while estimating page size.");
        return EINVAL;
      }
      for (i = begin; i < end; i++) {
        if ((i & 255) == 0) R_CheckUserInterrupt();
        NANOARROW_RETURN_NOT_OK(estimate_value(view->children[0], i, total,
                                                limit, error));
      }
      return NANOARROW_OK;
    }
    case NANOARROW_TYPE_FIXED_SIZE_LIST:
      for (i = 0; i < view->layout.child_size_elements; i++) {
        if ((i & 255) == 0) R_CheckUserInterrupt();
        NANOARROW_RETURN_NOT_OK(estimate_value(view->children[0],
                                               (view->offset + index) *
                                                   view->layout.child_size_elements + i,
                                               total, limit, error));
      }
      return NANOARROW_OK;
    default:
      if (view->layout.element_size_bits[1] > 0)
        NANOARROW_RETURN_NOT_OK(add_bytes(
            total, (view->layout.element_size_bits[1] + 7) / 8, limit));
      return NANOARROW_OK;
  }
}

static int estimate_dictionary(const struct ArrowArrayView* view,
                               int64_t* total, int64_t limit,
                               struct ArrowError* error) {
  int64_t i;
  if (view->dictionary) {
    for (i = 0; i < view->dictionary->length; i++) {
      if ((i & 255) == 0) R_CheckUserInterrupt();
      int code = estimate_value(view->dictionary, i, total, limit, error);
      if (code != NANOARROW_OK) {
        if (error->message[0] == '\0')
          ArrowErrorSet(error, "Could not estimate dictionary value %" PRId64 ".", i);
        return code;
      }
    }
  }
  for (i = 0; i < view->n_children; i++) {
    if ((i & 255) == 0) R_CheckUserInterrupt();
    NANOARROW_RETURN_NOT_OK(estimate_dictionary(view->children[i], total,
                                                 limit, error));
  }
  return NANOARROW_OK;
}

typedef struct {
  struct ArrowBuffer* buffer;
  int64_t max_bytes;
} jdv_capped_output;

static ArrowErrorCode capped_write(struct ArrowIpcOutputStream* stream,
                                   const void* data, int64_t size,
                                   int64_t* written,
                                   struct ArrowError* error) {
  jdv_capped_output* out = (jdv_capped_output*)stream->private_data;
  int64_t required, capacity;
  if (size < 0 || out->buffer->size_bytes > out->max_bytes ||
      size > out->max_bytes - out->buffer->size_bytes) {
    ArrowErrorSet(error, "Encoded Arrow page exceeds max_bytes.");
    *written = 0;
    return EOVERFLOW;
  }
  required = out->buffer->size_bytes + size;
  if (required > out->buffer->capacity_bytes) {
    uint8_t* next;
    capacity = out->buffer->capacity_bytes > 0
                   ? out->buffer->capacity_bytes
                   : (out->max_bytes < 64 ? out->max_bytes : 64);
    while (capacity < required && capacity < out->max_bytes) {
      if (capacity > out->max_bytes / 2) {
        capacity = out->max_bytes;
        break;
      }
      capacity *= 2;
    }
    if (capacity < required) capacity = required;
    next = (uint8_t*)realloc(out->buffer->data, (size_t)capacity);
    if (next == NULL && capacity > 0) {
      ArrowErrorSet(error, "Could not allocate bounded IPC output storage.");
      *written = 0;
      return ENOMEM;
    }
    out->buffer->data = next;
    out->buffer->capacity_bytes = capacity;
  }
  if (size > 0)
    memcpy(out->buffer->data + out->buffer->size_bytes, data, (size_t)size);
  out->buffer->size_bytes = required;
  *written = size;
  return NANOARROW_OK;
}

static void capped_release(struct ArrowIpcOutputStream* stream) {
  stream->release = NULL;
}

static void release_array(void* data) {
  struct ArrowArray* array = (struct ArrowArray*)data;
  if (array->release) array->release(array);
}

static void release_schema(void* data) {
  struct ArrowSchema* schema = (struct ArrowSchema*)data;
  if (schema->release) schema->release(schema);
}

static void release_stream(void* data) {
  struct ArrowArrayStream* stream = (struct ArrowArrayStream*)data;
  if (stream->release) stream->release(stream);
}

typedef struct {
  const struct ArrowSchema* schema;
  const struct ArrowArray* batch;
  int64_t offset;
  int64_t max_rows;
  int64_t max_bytes;
  struct ArrowError* error;

  struct ArrowSchema page_schema;
  struct ArrowArray page_array;
  struct ArrowArrayView source_view;
  struct ArrowArrayStream one_batch;
  struct ArrowBuffer bytes;
  struct ArrowIpcOutputStream output;
  struct ArrowIpcWriter writer;
  jdv_capped_output capped;
  struct ArrowArray empty_batch;

  uint8_t* payload;
  int64_t payload_size;
  int64_t rows;
  int code;
  const char* stage;
  int source_view_live;
  int schema_live;
  int array_live;
  int stream_live;
  int writer_live;
  int empty_live;
} jdv_page_encode_context;

static SEXP page_encode_body(void* data) {
  jdv_page_encode_context* ctx = (jdv_page_encode_context*)data;
  const struct ArrowSchema* schema = ctx->schema;
  const struct ArrowArray* batch = ctx->batch;
  int64_t offset = ctx->offset;
  int64_t max_rows = ctx->max_rows;
  int64_t max_bytes = ctx->max_bytes;
  struct ArrowError* error = ctx->error;
  int64_t n, row, col, dst_col, n_supported, estimate, dictionary_estimate;
  int64_t root_offset;

  if (offset < 0 || max_rows < 0 || max_bytes < 0 ||
      (batch != NULL && offset > batch->length)) {
    ArrowErrorSet(error, "Invalid Arrow page slice or budget.");
    ctx->code = EINVAL;
    return R_NilValue;
  }
  if (batch == NULL) {
    ctx->empty_live = 1;
    ctx->code = ArrowArrayInitFromSchema(&ctx->empty_batch, schema, error);
    if (ctx->code) return R_NilValue;
    ctx->code = ArrowArrayFinishBuildingDefault(&ctx->empty_batch, error);
    if (ctx->code) return R_NilValue;
    batch = &ctx->empty_batch;
    offset = 0;
    max_rows = 0;
  }
  n = batch->length - offset;
  if (n > max_rows) n = max_rows;

  ctx->schema_live = 1;
  ctx->stage = "building page schema";
  ctx->code = make_page_schema(schema, &ctx->page_schema, &n_supported, error);
  if (ctx->code) return R_NilValue;
  ctx->stage = "initializing destination array";
  ctx->array_live = 1;
  ctx->code = ArrowArrayInitFromSchema(&ctx->page_array, &ctx->page_schema, error);
  if (ctx->code) return R_NilValue;
  ctx->stage = "starting destination append";
  ctx->code = ArrowArrayStartAppending(&ctx->page_array);
  if (ctx->code) return R_NilValue;
  ctx->source_view_live = 1;
  ArrowArrayViewInitFromType(&ctx->source_view, NANOARROW_TYPE_UNINITIALIZED);
  ctx->stage = "initializing source array view";
  ctx->code = ArrowArrayViewInitFromSchema(&ctx->source_view, schema, error);
  if (ctx->code) return R_NilValue;
  ctx->stage = "validating source array view";
  ctx->code = ArrowArrayViewSetArray(&ctx->source_view, batch, error);
  if (ctx->code) return R_NilValue;
  root_offset = ctx->source_view.offset;

  ctx->stage = "estimating dictionary storage";
  dictionary_estimate = 0;
  for (col = 0; col < schema->n_children; col++) {
    if ((col & 255) == 0) R_CheckUserInterrupt();
    if (!schema_supported(schema->children[col])) continue;
    ctx->code = estimate_dictionary(ctx->source_view.children[col],
                                    &dictionary_estimate, max_bytes, error);
    if (ctx->code) return R_NilValue;
  }
  estimate = dictionary_estimate;
  n = 0;
  while (n < max_rows && offset + n < batch->length) {
    int64_t row_estimate = 0;
    R_CheckUserInterrupt();
    for (col = 0; col < schema->n_children; col++) {
      if ((col & 255) == 0) R_CheckUserInterrupt();
      if (!schema_supported(schema->children[col])) continue;
      ctx->code = estimate_value(ctx->source_view.children[col],
                                 root_offset + offset + n, &row_estimate,
                                 max_bytes - estimate, error);
      if (ctx->code) break;
    }
    if (ctx->code == EOVERFLOW) {
      ctx->code = NANOARROW_OK;
      if (n == 0) {
        ArrowErrorSet(error, "One Arrow row exceeds max_bytes.");
        ctx->code = EOVERFLOW;
      }
      break;
    }
    if (ctx->code != NANOARROW_OK) return R_NilValue;
    if (row_estimate > max_bytes - estimate) break;
    estimate += row_estimate;
    n++;
  }
  if (ctx->code) return R_NilValue;
  if (n == 0 && batch->length > offset && max_rows > 0) {
    ArrowErrorSet(error, "One Arrow row exceeds max_bytes.");
    ctx->code = EOVERFLOW;
    return R_NilValue;
  }

  ctx->stage = "copying dictionaries";
  dst_col = 0;
  for (col = 0; col < schema->n_children; col++) {
    if ((col & 255) == 0) R_CheckUserInterrupt();
    if (!schema_supported(schema->children[col])) continue;
    ctx->code = append_dictionary(ctx->page_array.children[dst_col],
                                  ctx->source_view.children[col], error);
    if (ctx->code) return R_NilValue;
    dst_col++;
  }
  ctx->stage = "copying page rows";
  for (row = 0; row < n; row++) {
    R_CheckUserInterrupt();
    dst_col = 0;
    for (col = 0; col < schema->n_children; col++) {
      if ((col & 255) == 0) R_CheckUserInterrupt();
      if (!schema_supported(schema->children[col])) continue;
      ctx->code = append_value(ctx->page_array.children[dst_col],
                               ctx->source_view.children[col],
                               root_offset + offset + row, error);
      if (ctx->code) return R_NilValue;
      dst_col++;
    }
    ctx->code = ArrowArrayFinishElement(&ctx->page_array);
    if (ctx->code) return R_NilValue;
  }
  ArrowArrayViewReset(&ctx->source_view);
  ctx->source_view_live = 0;

  ctx->stage = "finishing page array";
  ctx->code = ArrowArrayFinishBuildingDefault(&ctx->page_array, error);
  if (ctx->code) return R_NilValue;

  ctx->stage = "initializing page stream";
  ctx->stream_live = 1;
  ctx->code = ArrowBasicArrayStreamInit(&ctx->one_batch, &ctx->page_schema, 1);
  if (ctx->code) return R_NilValue;
  ctx->schema_live = 0;
  ArrowBasicArrayStreamSetArray(&ctx->one_batch, 0, &ctx->page_array);
  ctx->array_live = 0;
  ctx->capped.buffer = &ctx->bytes;
  ctx->capped.max_bytes = max_bytes;
  ctx->output.write = capped_write;
  ctx->output.release = capped_release;
  ctx->output.private_data = &ctx->capped;
  ctx->stage = "initializing IPC writer";
  ctx->writer_live = 1;
  ctx->code = ArrowIpcWriterInit(&ctx->writer, &ctx->output);
  if (ctx->code) return R_NilValue;
  ctx->stage = "writing IPC stream";
  ctx->code = ArrowIpcWriterWriteArrayStream(&ctx->writer, &ctx->one_batch,
                                             error);
  if (ctx->code) return R_NilValue;
  if (ctx->bytes.size_bytes > max_bytes) {
    ArrowErrorSet(error, "Encoded Arrow page exceeds max_bytes.");
    ctx->code = EOVERFLOW;
    return R_NilValue;
  }
  ctx->payload = (uint8_t*)malloc((size_t)ctx->bytes.size_bytes);
  if (!ctx->payload && ctx->bytes.size_bytes > 0) {
    ArrowErrorSet(error, "Could not allocate Arrow page output.");
    ctx->code = ENOMEM;
    return R_NilValue;
  }
  if (ctx->bytes.size_bytes > 0)
    memcpy(ctx->payload, ctx->bytes.data, (size_t)ctx->bytes.size_bytes);
  ctx->payload_size = ctx->bytes.size_bytes;
  ctx->rows = n;
  ctx->code = NANOARROW_OK;
  return R_NilValue;
}

static void page_encode_cleanup(void* data) {
  jdv_page_encode_context* ctx = (jdv_page_encode_context*)data;
  if (ctx->writer_live) ArrowIpcWriterReset(&ctx->writer);
  if (ctx->stream_live) (void)R_ToplevelExec(release_stream, &ctx->one_batch);
  if (ctx->array_live && ctx->page_array.release)
    (void)R_ToplevelExec(release_array, &ctx->page_array);
  if (ctx->schema_live && ctx->page_schema.release)
    (void)R_ToplevelExec(release_schema, &ctx->page_schema);
  if (ctx->source_view_live) ArrowArrayViewReset(&ctx->source_view);
  if (ctx->empty_live && ctx->empty_batch.release)
    (void)R_ToplevelExec(release_array, &ctx->empty_batch);
  ArrowBufferReset(&ctx->bytes);
  if (ctx->code != NANOARROW_OK) {
    free(ctx->payload);
    ctx->payload = NULL;
    ctx->payload_size = 0;
    ctx->rows = 0;
    if (ctx->error && ctx->error->message[0] == '\0')
      ArrowErrorSet(ctx->error,
                    "Could not encode Arrow page while %s (error %d).",
                    ctx->stage, ctx->code);
  }
}

/*
 * A bounded prototype encoder: it copies a single source-batch slice into
 * offset-zero storage and writes a self-contained IPC stream. The caller owns
 * cursor advancement and commits it only after this function succeeds.
 */
int jdv_arrow_page_encode(const struct ArrowSchema* schema,
                          const struct ArrowArray* batch, int64_t offset,
                          int64_t max_rows, int64_t max_bytes,
                          uint8_t** data_out, int64_t* size_out,
                          int64_t* rows_out, struct ArrowError* error) {
  jdv_page_encode_context ctx;
  *data_out = NULL;
  *size_out = 0;
  *rows_out = 0;
  memset(&ctx, 0, sizeof(ctx));
  ctx.schema = schema;
  ctx.batch = batch;
  ctx.offset = offset;
  ctx.max_rows = max_rows;
  ctx.max_bytes = max_bytes;
  ctx.error = error;
  ctx.code = NANOARROW_OK;
  ctx.stage = "initialization";
  memset(&ctx.page_schema, 0, sizeof(ctx.page_schema));
  memset(&ctx.page_array, 0, sizeof(ctx.page_array));
  memset(&ctx.empty_batch, 0, sizeof(ctx.empty_batch));
  memset(&ctx.one_batch, 0, sizeof(ctx.one_batch));
  memset(&ctx.output, 0, sizeof(ctx.output));
  memset(&ctx.writer, 0, sizeof(ctx.writer));
  memset(&ctx.capped, 0, sizeof(ctx.capped));
  ArrowBufferInit(&ctx.bytes);
  (void)R_ExecWithCleanup(page_encode_body, &ctx, page_encode_cleanup, &ctx);
  if (ctx.code == NANOARROW_OK) {
    *data_out = ctx.payload;
    *size_out = ctx.payload_size;
    *rows_out = ctx.rows;
    ctx.payload = NULL;
  }
  return ctx.code;
}
