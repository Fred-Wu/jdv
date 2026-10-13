#ifndef JDV_TRANSPORT_H
#define JDV_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

typedef struct jdv_transport_state jdv_transport_state;

void jdv_loop_start(uintptr_t fd);
void jdv_loop_stop(void);
int jdv_loop_source_active(void);
void jdv_transport_on_readable(void);
void jdv_transport_on_timer(void);
int jdv_transport_loop_fd(void);
void jdv_transport_mark_source_stopped(void);
int jdv_module_depth(void);
void jdv_module_enter(void);
void jdv_module_leave(void);
void jdv_transport_unload(void);

#endif
