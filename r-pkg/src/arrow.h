#ifndef JDV_ARROW_H
#define JDV_ARROW_H

#include <Rinternals.h>

SEXP C_jdv_arrow_move(SEXP exported);
SEXP C_jdv_arrow_schema(SEXP token);
SEXP C_jdv_arrow_next(SEXP token);
SEXP C_jdv_arrow_close(SEXP token);
SEXP C_jdv_arrow_info(SEXP token);
SEXP C_jdv_arrow_cleanup(void);
SEXP C_jdv_arrow_status(void);
SEXP C_jdv_arrow_open(SEXP token);
SEXP C_jdv_arrow_page(SEXP token, SEXP max_rows, SEXP max_bytes);
int jdv_arrow_can_unload(void);
void jdv_arrow_unload(void);

#endif
