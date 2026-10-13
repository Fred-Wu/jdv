#ifndef JDV_JSON_H
#define JDV_JSON_H

#include <stddef.h>

/* Validate a complete, bounded UTF-8 JSON value without using the R API. */
int jdv_json_validate(const unsigned char *text, size_t length,
                      size_t max_bytes);
int jdv_json_validate_output(const unsigned char *text, size_t length,
                             size_t max_bytes);

#endif
