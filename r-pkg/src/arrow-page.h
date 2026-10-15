#ifndef JDV_ARROW_PAGE_H
#define JDV_ARROW_PAGE_H

#include <nanoarrow/nanoarrow.h>

/* Encode one source-batch slice as an independent IPC stream. */
int jdv_arrow_page_encode(const struct ArrowSchema *schema,
                          const struct ArrowArray *batch, int64_t offset,
                          int64_t max_rows, int64_t max_bytes,
                          uint8_t **data_out, int64_t *size_out,
                          int64_t *rows_out, struct ArrowError *error);

#endif
