/* Mechanically aggregated from the pinned flatcc runtime headers. */
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_accessors_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_accessors_h
#ifndef FLATCC_ACCESSORS
#define FLATCC_ACCESSORS

#ifdef __cplusplus
extern "C" {
#endif

#ifndef UINT8_MAX
#include <stdint.h>
#endif


#define __flatcc_basic_scalar_accessors_impl(N, T, W, E)                    \
static inline size_t N ## __size(void)                                      \
{ return sizeof(T); }                                                       \
static inline T *N ## __ptr_add(T *p, size_t i)                             \
{ return p + i; }                                                           \
static inline const T *N ## __const_ptr_add(const T *p, size_t i)           \
{ return p + i; }                                                           \
static inline T N ## _read_from_pe(const void *p)                           \
{ return N ## _cast_from_pe(N ## _read(p)); }                               \
static inline T N ## _read_to_pe(const void *p)                             \
{ return N ## _cast_to_pe(N ## _read(p)); }                                 \
static inline void N ## _write_from_pe(void *p, T v)                        \
{ N ## _write(p, N ## _cast_from_pe(v)); }                                  \
static inline void N ## _write_to_pe(void *p, T v)                          \
{ N ## _write(p, N ## _cast_to_pe(v)); }                                    \
static inline T N ## _read_from_le(const void *p)                           \
{ return N ## _cast_from_le(N ## _read(p)); }                               \
typedef struct { int is_null; T value; } N ## _option_t;

#define __flatcc_define_integer_accessors_impl(N, T, W, E)                  \
static inline T N ##  _read(const void *p)                                  \
{ return (T) mem_read_ ## W(p); }                                           \
static inline void N ##  _write(void *p, T v)                               \
{ mem_write_ ## W(p, v); }                                                  \
static inline T N ## _cast_from_pe(T v)                                     \
{ return (T) E ## W ## toh((uint ## W ## _t)v); }                           \
static inline T N ## _cast_to_pe(T v)                                       \
{ return (T) hto ## E ## W((uint ## W ## _t)v); }                           \
static inline T N ## _cast_from_le(T v)                                     \
{ return (T) le ## W ## toh((uint ## W ## _t)v); }                          \
static inline T N ## _cast_to_le(T v)                                       \
{ return (T) htole ## W((uint ## W ## _t)v); }                              \
static inline T N ## _cast_from_be(T v)                                     \
{ return (T) be ## W ## toh((uint ## W ## _t)v); }                          \
static inline T N ## _cast_to_be(T v)                                       \
{ return (T) htobe ## W((uint ## W ## _t)v); }                              \
__flatcc_basic_scalar_accessors_impl(N, T, W, E)

#define __flatcc_define_real_accessors_impl(N, T, W, E)                     \
static inline T N ##  _read(const void *p)                                  \
{ return (T) mem_read_float_ ## W(p); }                                     \
static inline void N ##  _write(void *p, T v)                               \
{ mem_write_float_ ## W(p, v); }                                            \
union __ ## N ## _cast { T v; uint ## W ## _t u; };                         \
static inline T N ## _cast_from_pe(T v)                                     \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = E ## W ## toh(x.u); return x.v; }                          \
static inline T N ## _cast_to_pe(T v)                                       \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = hto ## E ## W(x.u); return x.v; }                          \
static inline T N ## _cast_from_le(T v)                                     \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = le ## W ## toh(x.u); return x.v; }                         \
static inline T N ## _cast_to_le(T v)                                       \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = htole ## W(x.u); return x.v; }                             \
static inline T N ## _cast_from_be(T v)                                     \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = be ## W ## toh(x.u); return x.v; }                         \
static inline T N ## _cast_to_be(T v)                                       \
{ union __ ## N ## _cast x;                                                 \
  x.v = v; x.u = htobe ## W(x.u); return x.v; }                             \
__flatcc_basic_scalar_accessors_impl(N, T, W, E)

#define __flatcc_define_integer_accessors(N, T, W, E)                       \
__flatcc_define_integer_accessors_impl(N, T, W, E)

#define __flatcc_define_real_accessors(N, T, W, E)                          \
__flatcc_define_real_accessors_impl(N, T, W, E)

#define __flatcc_define_basic_integer_accessors(NS, TN, T, W, E)            \
__flatcc_define_integer_accessors(NS ## TN, T, W, E)

#define __flatcc_define_basic_real_accessors(NS, TN, T, W, E)               \
__flatcc_define_real_accessors(NS ## TN, T, W, E)

#define __flatcc_define_basic_scalar_accessors(NS, E)                       \
__flatcc_define_basic_integer_accessors(NS, char, char, 8, E)               \
__flatcc_define_basic_integer_accessors(NS, uint8, uint8_t, 8, E)           \
__flatcc_define_basic_integer_accessors(NS, uint16, uint16_t, 16, E)        \
__flatcc_define_basic_integer_accessors(NS, uint32, uint32_t, 32, E)        \
__flatcc_define_basic_integer_accessors(NS, uint64, uint64_t, 64, E)        \
__flatcc_define_basic_integer_accessors(NS, int8, int8_t, 8, E)             \
__flatcc_define_basic_integer_accessors(NS, int16, int16_t, 16, E)          \
__flatcc_define_basic_integer_accessors(NS, int32, int32_t, 32, E)          \
__flatcc_define_basic_integer_accessors(NS, int64, int64_t, 64, E)          \
__flatcc_define_basic_real_accessors(NS, float, float, 32, E)               \
__flatcc_define_basic_real_accessors(NS, double, double, 64, E)

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_ACCESSORS */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h
#ifndef FLATCC_ALLOC_H
#define FLATCC_ALLOC_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * These allocation abstractions are __only__ for runtime libraries.
 *
 * The flatcc compiler uses Posix allocation routines regardless
 * of how this file is configured.
 *
 * This header makes it possible to use systems where malloc is not
 * valid to use. In this case the portable library will not help
 * because it implements Posix / C11 abstractions.
 *
 * Systems like FreeRTOS do not work with Posix memory calls and here it
 * can be helpful to override runtime allocation primitives.
 *
 * In general, it is better to customize the allocator and emitter via
 * flatcc_builder_custom_init and to avoid using the default emitter
 * specific high level calls the copy out a buffer that must later be
 * deallocated. This provides full control of allocation withou the need
 * for this file.
 *
 *
 * IMPORTANT
 *
 * If you override malloc, free, etc., make sure your applications
 * use the same allocation methods. For example, samples/monster.c
 * and several test cases are no longer guaranteed to work out of the
 * box.
 *
 * The changes must only affect target runtime compilation including the
 * the runtime library libflatccrt.
 *
 * The host system flatcc compiler and the compiler library libflatcc
 * should NOT be compiled with non-Posix allocation since the compiler
 * has a dependency on the runtime library and the wrong free operation
 * might be callled. The safest way to avoid this problem this is to
 * compile flatcc with the CMake script and the runtime files with a
 * dedicated build system for the target system.
 */

#include <stdlib.h>

#ifndef FLATCC_ALLOC
#define FLATCC_ALLOC(n) malloc(n)
#endif

#ifndef FLATCC_FREE
#define FLATCC_FREE(p) free(p)
#endif

#ifndef FLATCC_REALLOC
#define FLATCC_REALLOC(p, n) realloc(p, n)
#endif

#ifndef FLATCC_CALLOC
#define FLATCC_CALLOC(nm, n) calloc(nm, n)
#endif

/*
 * Implements `aligned_alloc` and `aligned_free`.
 * Even with C11, this implements non-standard aligned_free needed for portable
 * aligned_alloc implementations.
 */
#ifndef FLATCC_USE_GENERIC_ALIGNED_ALLOC

#ifndef FLATCC_NO_PALIGNED_ALLOC
#define JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h
#else
#if !defined(__aligned_free_is_defined) || !__aligned_free_is_defined
#define aligned_free free
#endif
#endif

#else /* FLATCC_USE_GENERIC_ALIGNED_ALLOC */

#ifndef FLATCC_ALIGNED_ALLOC
static inline void *__flatcc_aligned_alloc(size_t alignment, size_t size)
{
    char *raw;
    void *buf;
    size_t total_size = (size + alignment - 1 + sizeof(void *));

    if (alignment < sizeof(void *)) {
        alignment = sizeof(void *);
    }
    raw = (char *)(size_t)FLATCC_ALLOC(total_size);
    if (!raw) return 0;
    buf = raw + alignment - 1 + sizeof(void *);
    buf = (void *)(((size_t)buf) & ~(alignment - 1));
    ((void **)buf)[-1] = raw;
    return buf;
}
#define FLATCC_ALIGNED_ALLOC(alignment, size) __flatcc_aligned_alloc(alignment, size)
#endif /* FLATCC_USE_GENERIC_ALIGNED_ALLOC */

#ifndef FLATCC_ALIGNED_FREE
static inline void __flatcc_aligned_free(void *p)
{
    char *raw;

    if (!p) return;
    raw = ((void **)p)[-1];

    FLATCC_FREE(raw);
}
#define FLATCC_ALIGNED_FREE(p) __flatcc_aligned_free(p)
#endif

#endif /* FLATCC_USE_GENERIC_ALIGNED_ALLOC */

#ifndef FLATCC_ALIGNED_ALLOC
#define FLATCC_ALIGNED_ALLOC(a, n) aligned_alloc(a, n)
#endif

#ifndef FLATCC_ALIGNED_FREE
#define FLATCC_ALIGNED_FREE(p) aligned_free(p)
#endif

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_ALLOC_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_assert_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_assert_h
#ifndef FLATCC_ASSERT_H
#define FLATCC_ASSERT_H

#ifdef __cplusplus
extern "C" {
#endif

/*
* This assert abstraction is only used for the flatcc runtime library.
* The flatcc compiler uses Posix assert routines regardless of how this
* file is configured.
*
* This header makes it possible to use systems where assert is not
* valid to use. Note that `<assert.h>` may remain a dependency for static
* assertions.
*
* `FLATCC_ASSERT` is designed to handle errors which cannot be ignored
* and could lead to crash. The portable library may use assertions that
* are not affected by this macro.
*
* `FLATCC_ASSERT` defaults to POSIX assert but can be overrided by a
* preprocessor definition.
*
* Runtime assertions can be entirely disabled by defining
* `FLATCC_NO_ASSERT`.
*/

#ifdef FLATCC_NO_ASSERT
/* NOTE: This will not affect inclusion of <assert.h> for static assertions. */
#undef FLATCC_ASSERT
#define FLATCC_ASSERT(x) ((void)0)
/* Grisu3 is used for floating point conversion in JSON processing. */
#define GRISU3_NO_ASSERT
#endif

#ifndef FLATCC_ASSERT
#include <assert.h>
#define FLATCC_ASSERT assert
#endif

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_ASSERT_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_builder_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_builder_h
#ifndef FLATCC_BUILDER_H
#define FLATCC_BUILDER_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Library for building untyped FlatBuffers. Intended as a support
 * library for generated C code to produce typed builders, but might
 * also be useful in runtime environments and as support for scripting
 * languages.
 *
 * The builder has two API layers: a stack based `start/end` approach,
 * and a direct `create`, and they may be mixed freely. The direct
 * approach may be used as part of more specialized optimizations such
 * as rewriting buffers while the stack approach is convenient for state
 * machine driven parsers without a stack, or with a very simple stack
 * without extra allocations.
 *
 * The builder emits partial buffer sequences to a user provided emitter
 * function and does not require a full buffer reprensenation in memory.
 * For this reason it also does not support sorting or other operations
 * that requires representing the buffer, but post-processors can easily
 * do this, and the generated schema specific code and provide functions
 * to handle this.
 *
 * A custom allocator with a default realloc implementation can place
 * restraints on resource consumption and provide initial allocation
 * sizes for various buffers and stacks in use.
 *
 * A buffer under construction uses a virtual address space for the
 * completed part of the buffer, starting at 0 and growing in both
 * directions, or just down depending on whether vtables should be
 * clustered at the end or not. Clustering may help caching and
 * preshipping that part of the buffer.
 *
 * Because an offset cannot be known before its reference location is
 * defined, every completed table, vector, etc. returns a reference into
 * the virtual address range. If the final buffer keeps the 0 offset,
 * these references remain stable an may be used for external references
 * into the buffer.
 *
 * The maximum buffer that can be constructed is in praxis limited to
 * half the UOFFSET_MAX size, typically 2^31 bytes, not counting
 * clustered vtables that may consume and additional 2^31 bytes
 * (positive address range), but in praxis cannot because vtable
 * references are signed and thus limited to 2^31 bytes (or equivalent
 * depending on the flatbuffer types chosen).
 *
 * CORRECTION: in various places rules are mentioned about nesting and using
 * a reference at most once. In fact, DAG's are also valid flatbuffers.
 * This means a reference may be reused as long as each individual use
 * obeys the rules and, for example, circular references are not
 * constructed (circular types are ok, but objects graphs with cycles
 * are not permitted). Be especially aware of the offset vector create
 * call which translates the references into offsets - this can be
 * reverted by noting the reference in vector and calculate the base
 * used for the offset to restore the original references after the
 * vector has been emitted.
 */

#include <stdlib.h>
#ifndef UINT8_MAX
#include <stdint.h>
#endif
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_flatbuffers_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_flatbuffers_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_emitter_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_emitter_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_refmap_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_refmap_h

/* It is possible to enable logging here. */
#ifndef FLATCC_BUILDER_ASSERT
#define FLATCC_BUILDER_ASSERT(cond, reason) FLATCC_ASSERT(cond)
#endif

/*
 * Eror handling is not convenient and correct use should not cause
 * errors beyond possibly memory allocation, but assertions are a
 * good way to trace problems.
 *
 * Note: some internal assertion will remain if disabled.
 */
#ifndef FLATCC_BUILDER_ASSERT_ON_ERROR
#define FLATCC_BUILDER_ASSERT_ON_ERROR 1
#endif

/*
 * If set, checks user input agains state and returns error,
 * otherwise errors are ignored (assuming they won't happen).
 * Errors will be asserted if enabled and checks are not skipped.
 */
#ifndef FLATCC_BUILDER_SKIP_CHECKS
#define FLATCC_BUILDER_SKIP_CHECKS 0
#endif


/*
 * When adding the same field to a table twice this is either an error
 * or the existing field is returned, potentially introducing garbage
 * if the type is a vector, table, or string. When implementing parsers
 * it may be convenient to not treat this as an error.
 */
#ifndef FLATCC_BUILDER_ALLOW_REPEAT_TABLE_ADD
#define FLATCC_BUILDER_ALLOW_REPEAT_TABLE_ADD 0
#endif

/**
 * This type must have same size as `flatbuffers_uoffset_t`
 * and must be a signed type.
 */
typedef flatbuffers_soffset_t flatcc_builder_ref_t;
typedef flatbuffers_utype_t flatcc_builder_utype_t;

/**
 * This type must be compatible with code generation that
 * creates union specific ref types.
 */
typedef struct flatcc_builder_union_ref {
    flatcc_builder_utype_t type;
    flatcc_builder_ref_t value;
} flatcc_builder_union_ref_t;

typedef struct flatcc_builder_union_vec_ref {
    flatcc_builder_ref_t type;
    flatcc_builder_ref_t value;
} flatcc_builder_union_vec_ref_t;

/**
 * Virtual tables are off by one to avoid being mistaken for error at
 * position 0, and it makes them detectable as such because no other
 * reference is uneven. Vtables are emitted at their actual location
 * which is one less than the reference value.
 */
typedef flatbuffers_soffset_t flatcc_builder_vt_ref_t;

typedef flatbuffers_uoffset_t flatcc_builder_identifier_t;

/**
 * Hints to custom allocators so they can provide initial alloc sizes
 * etc. There will be at most one buffer for each allocation type per
 * flatcc_builder instance. Buffers containing only structs may avoid
 * allocation altogether using a `create` call. The vs stack must hold
 * vtable entries for all open tables up to their requested max id, but
 * unused max id overlap on the stack. The final vtables only store the
 * largest id actually added. The fs stack must hold stack frames for
 * the nesting levels expected in the buffer, each about 50-100 bytes.
 * The ds stack holds open vectors, table data, and nested buffer state.
 * `create` calls bypass the `ds` and `fs` stack and are thus faster.
 * The vb buffer holds a copy of all vtables seen and emitted since last
 * vtable flush. The patch log holds a uoffset for every table field
 * added to currently open tables. The hash table holds a uoffset entry
 * for each hash slot where the allocator decides how many to provide
 * above a certain minimum. The vd buffer allocates vtable descriptors
 * which is a reference to an emitted vtable, an offset to a cached
 * vtable, and a link to next descriptor with same hash. Calling `reset`
 * after build can either keep the allocation levels for the next
 * buffer, or reduce the buffers already allocated by requesting 1 byte
 * allocations (meaning provide a default).
 *
 * The user stack is not automatically allocated, but when entered
 * explicitly, the boundary is rembered in the current live
 * frame.
 */
enum flatcc_builder_alloc_type {
    /* The stack where vtables are build. */
    flatcc_builder_alloc_vs,
    /* The stack where data structures are build. */
    flatcc_builder_alloc_ds,
    /* The virtual table buffer cache, holds a copy of each vt seen. */
    flatcc_builder_alloc_vb,
    /* The patch log, remembers table fields with outstanding offset refs. */
    flatcc_builder_alloc_pl,
    /* The stack of frames for nested types. */
    flatcc_builder_alloc_fs,
    /* The hash table part of the virtual table cache. */
    flatcc_builder_alloc_ht,
    /* The vtable descriptor buffer, i.e. list elements for emitted vtables. */
    flatcc_builder_alloc_vd,
    /* User stack frame for custom data. */
    flatcc_builder_alloc_us,

    /* Number of allocation buffers. */
    flatcc_builder_alloc_buffer_count
};

/** Must reflect the `flatcc_builder_alloc_type` enum. */
#define FLATCC_BUILDER_ALLOC_BUFFER_COUNT flatcc_builder_alloc_buffer_count

#ifndef FLATCC_BUILDER_ALLOC
#define FLATCC_BUILDER_ALLOC(n) FLATCC_ALLOC(n)
#endif

#ifndef FLATCC_BUILDER_FREE
#define FLATCC_BUILDER_FREE(p) FLATCC_FREE(p)
#endif

#ifndef FLATCC_BUILDER_REALLOC
#define FLATCC_BUILDER_REALLOC(p, n) FLATCC_REALLOC(p, n)
#endif

#ifndef FLATCC_BUILDER_ALIGNED_ALLOC
#define FLATCC_BUILDER_ALIGNED_ALLOC(a, n) FLATCC_ALIGNED_ALLOC(a, n)
#endif

#ifndef FLATCC_BUILDER_ALIGNED_FREE
#define FLATCC_BUILDER_ALIGNED_FREE(p) FLATCC_ALIGNED_FREE(p)
#endif

/**
 * Emits data to a conceptual deque by appending to either front or
 * back, starting from offset 0.
 *
 * Each emit call appends a strictly later or earlier sequence than the
 * last emit with same offset sign. Thus a buffer is gradually grown at
 * both ends. `len` is the combined length of all iov entries such that
 * `offset + len` yields the former offset for negative offsets and
 * `offset + len` yields the next offset for non-negative offsets.
 * The bulk of the data will be in the negative range, possibly all of
 * it. The first emitted emitted range will either start or end at
 * offset 0. If offset 0 is emitted, it indicates the start of clustered
 * vtables. The last positive (non-zero) offset may be zero padding to
 * place the buffer in a full multiple of `block_align`, if set.
 *
 * No iov entry is empty, 0 < iov_count <= FLATCC_IOV_COUNT_MAX.
 *
 * The source data are in general ephemeral and should be consumed
 * immediately, as opposed to caching iov.
 *
 * For high performance applications:
 *
 * The `create` calls may reference longer living data, but header
 * fields etc. will still be short lived. If an emitter wants to
 * reference data in another buffer rather than copying, it should
 * inspect the memory range. The length of an iov entry may also be used
 * since headers are never very long (anything starting at 16 bytes can
 * safely be assumed to be user provided, or static zero padding). It is
 * guaranteed that data pointers in `create` calls receive a unique slot
 * separate from temporary headers, in the iov table which may be used
 * for range checking or hashing (`create_table` is the only call that
 * mutates the data buffer). It is also guaranteed (with the exception
 * of `create_table` and `create_cached_vtable`) that data provided to
 * create calls are not referenced at all by the builder, and these data
 * may therefore de-facto be handles rather than direct pointers when
 * the emitter and data provider can agree on such a protocol. This does
 * NOT apply to any start/end/add/etc. calls which do copy to stack.
 * `flatcc_builder_padding_base` may be used to test if an iov entry is
 * zero padding which always begins at that address.
 *
 * Future: the emit interface could be extended with a type code
 * and return an existing object insted of the emitted if, for
 * example, they are identical. Outside this api level, generated
 * code could provide a table comparison function to help such
 * deduplication. It would be optional because two equal objects
 * are not necessarily identical. The emitter already receives
 * one object at time.
 *
 * Returns 0 on success and otherwise causes the flatcc_builder
 * to fail.
 */
typedef int flatcc_builder_emit_fun(void *emit_context,
        const flatcc_iovec_t *iov, int iov_count, flatbuffers_soffset_t offset, size_t len);

/*
 * Returns a pointer to static padding used in emitter calls. May
 * sometimes also be used for empty defaults such as identifier.
 */
extern const uint8_t flatcc_builder_padding_base[];

/**
 * `request` is a minimum size to be returned, but allocation is
 * expected to grow exponentially or in reasonable chunks. Notably,
 * `alloc_type = flatcc_builder_alloc_ht` will only use highest available
 * power of 2. The allocator may shrink if `request` is well below
 * current size but should avoid repeated resizing on small changes in
 * request sizes. If `zero_fill` is non-zero, allocated data beyond
 * the current size must be zeroed. The buffer `b` may be null with 0
 * length initially. `alloc_context` is completely implementation
 * dependendent, and not needed when just relying on realloc. The
 * resulting buffer may be the same or different with moved data, like
 * realloc. Returns -1 with unmodified buffer on failure or 0 on
 * success. The `alloc_type` identifies the buffer type. This may be
 * used to cache buffers between instances of builders, or to decide a
 * default allocation size larger than requested. If `need` is zero the
 * buffer should be deallocate if non-zero, and return success (0)
 * regardless.
 */
typedef int flatcc_builder_alloc_fun(void *alloc_context,
        flatcc_iovec_t *b, size_t request, int zero_fill, int alloc_type);

/*
 * The number of hash slots there will be allocated space for. The
 * allocator may provide more. The size returned should be
 * `sizeof(flatbuffers_uoffset_t) * count`, where the size is a power of
 * 2 (or the rest is wasted). The hash table can store many more entries
 * than slots using linear search. The table does not resize.
 */
#ifndef FLATCC_BUILDER_MIN_HASH_COUNT
#define FLATCC_BUILDER_MIN_HASH_COUNT 64
#endif

typedef struct __flatcc_builder_buffer_frame __flatcc_builder_buffer_frame_t;
struct __flatcc_builder_buffer_frame {
    flatcc_builder_identifier_t identifier;
    flatcc_builder_ref_t mark;
    flatbuffers_uoffset_t vs_end;
    flatbuffers_uoffset_t nest_id;
    uint16_t flags;
    uint16_t block_align;
};

typedef struct __flatcc_builder_vector_frame __flatcc_builder_vector_frame_t;
struct __flatcc_builder_vector_frame {
    flatbuffers_uoffset_t elem_size;
    flatbuffers_uoffset_t count;
    flatbuffers_uoffset_t max_count;
};

typedef struct __flatcc_builder_table_frame __flatcc_builder_table_frame_t;
struct __flatcc_builder_table_frame {
    flatbuffers_uoffset_t vs_end;
    flatbuffers_uoffset_t pl_end;
    uint32_t vt_hash;
    flatbuffers_voffset_t id_end;
};

/*
 * Store state for nested structures such as buffers, tables and vectors.
 *
 * For less busy data and data where access to a previous state is
 * irrelevant, the frame may store the current state directly. Otherwise
 * the current state is maintained in the flatcc_builder_t structure in a
 * possibly derived form (e.g. ds pointer instead of ds_end offset) and
 * the frame is used to store the previous state when the frame is
 * entered.
 *
 * Most operations have a start/update/end cycle the decides the
 * liftetime of a frame, but these generally also have a direct form
 * (create) that does not use a frame at all. These still do some
 * state updates notably passing min_align to parent which may also be
 * an operation without a frame following the child level operation
 * (e.g. create struct, create buffer). Ending a frame results in the
 * same kind of updates.
 */
typedef struct __flatcc_builder_frame __flatcc_builder_frame_t;
struct __flatcc_builder_frame {
    flatbuffers_uoffset_t ds_first;
    flatbuffers_uoffset_t type_limit;
    flatbuffers_uoffset_t ds_offset;
    uint16_t align;
    uint16_t type;
    union {
        __flatcc_builder_table_frame_t table;
        __flatcc_builder_vector_frame_t vector;
        __flatcc_builder_buffer_frame_t buffer;
    } container;
};

/**
 * The main flatcc_builder structure. Can be stack allocated and must
 * be initialized with `flatcc_builder_init` and cleared with
 * `flatcc_builder_clear` to reclaim memory. Between buffer builds,
 * `flatcc_builder_reset` may be used.
 */
typedef struct flatcc_builder flatcc_builder_t;

struct flatcc_builder {
    /* Next entry on reserved stack in `alloc_pl` buffer. */
    flatbuffers_voffset_t *pl;
    /* Next entry on reserved stack in `alloc_vs` buffer. */
    flatbuffers_voffset_t *vs;
    /* One above the highest entry in vs, used to track vt_size. */
    flatbuffers_voffset_t id_end;
    /* The evolving vtable hash updated with every new field. */
    uint32_t vt_hash;

    /* Pointer to ds_first. */
    uint8_t *ds;
    /* Offset from `ds` on current frame. */
    flatbuffers_uoffset_t ds_offset;
    /* ds buffer size relative to ds_first, clamped to max size of current type. */
    flatbuffers_uoffset_t ds_limit;

    /* ds_first, ds_first + ds_offset is current ds stack range. */
    flatbuffers_uoffset_t ds_first;
    /* Points to currently open frame in `alloc_fs` buffer. */
    __flatcc_builder_frame_t *frame;

    /* Only significant to emitter function, if at all. */
    void *emit_context;
    /* Only significant to allocator function, if at all. */
    void *alloc_context;
    /* Customizable write function that both appends and prepends data. */
    flatcc_builder_emit_fun *emit;
    /* Customizable allocator that also deallocates. */
    flatcc_builder_alloc_fun *alloc;
    /* Buffers indexed by `alloc_type` */
    flatcc_iovec_t buffers[FLATCC_BUILDER_ALLOC_BUFFER_COUNT];
    /* Number of slots in ht given as 1 << ht_width. */
    size_t ht_width;

    /* The location in vb to add next cached vtable. */
    flatbuffers_uoffset_t vb_end;
    /* Where to allocate next vtable descriptor for hash table. */
    flatbuffers_uoffset_t vd_end;
    /* Ensure final buffer is aligned to at least this. Nested buffers get their own `min_align`. */
    uint16_t min_align;
    /* The current active objects alignment isolated from nested activity. */
    uint16_t align;
    /* The current buffers block alignment used when emitting buffer. */
    uint16_t block_align;
    /* Signed virtual address range used for `flatcc_builder_ref_t` and emitter. */
    flatcc_builder_ref_t emit_start;
    flatcc_builder_ref_t emit_end;
    /* 0 for top level, and end of buffer ref for nested buffers (can also be 0). */
    flatcc_builder_ref_t buffer_mark;
    /* Next nest_id. */
    flatbuffers_uoffset_t nest_count;
    /* Unique id to prevent sharing of vtables across buffers. */
    flatbuffers_uoffset_t nest_id;
    /* Current nesting level. Helpful to state-machines with explicit stack and to check `max_level`. */
    int level;
    /* Aggregate check for allocated frame and max_level. */
    int limit_level;
    /* Track size prefixed buffer. */
    uint16_t buffer_flags;

    /* Settings that may happen with no frame allocated. */

    flatcc_builder_identifier_t identifier;

    /* Settings that survive reset (emitter, alloc, and contexts also survive): */

    /* If non-zero, vtable cache gets flushed periodically. */
    size_t vb_flush_limit;
    /* If non-zero, fails on deep nesting to help drivers with a stack, such as recursive parsers etc. */
    int max_level;
    /* If non-zero, do not cluster vtables at end, only emit negative offsets (0 by default). */
    int disable_vt_clustering;

    /* Set if the default emitter is being used. */
    int is_default_emitter;
    /* Only used with default emitter. */
    flatcc_emitter_t default_emit_context;

    /* Offset to the last entered user frame on the user frame stack, after frame header, or 0. */
    size_t user_frame_offset;

    /* The offset to the end of the most recent user frame. */
    size_t user_frame_end;

    /* The optional user supplied refmap for cloning DAG's - not shared with nested buffers. */
    flatcc_refmap_t *refmap;
};

/**
 * Call this before any other API call.
 *
 * The emitter handles the completed chunks of the buffer that will no
 * longer be required by the builder. It is largely a `write` function
 * that can append to both positive and negative offsets.
 *
 * No memory is allocated during init. Buffers will be allocated as
 * needed. The `emit_context` is only used by the emitter, if at all.
 *
 * `flatcc_builder_reset/clear` calls are automtically forwarded to the
 * default emitter.
 *
 * Returns -1 on failure, 0 on success.
 */
int flatcc_builder_init(flatcc_builder_t *B);

/**
 * Use instead of `flatcc_builder_init` when providing a custom allocator
 * or emitter. Leave emitter or allocator null to use default.
 * Cleanup of emit and alloc context must be handled manually after
 * the builder is cleared or reset, except if emitter is null the
 * default will be automatically cleared and reset.
 *
 * Returns -1 on failure, 0 on success.
 */
int flatcc_builder_custom_init(flatcc_builder_t *B,
        flatcc_builder_emit_fun *emit, void *emit_context,
        flatcc_builder_alloc_fun *alloc, void *alloc_context);

/*
 * Returns (flatcc_emitter_t *) if the default context is used.
 * Other emitter might have null contexts.
 */
void *flatcc_builder_get_emit_context(flatcc_builder_t *B);

/**
 * Prepares builder for a new build. The emitter is not told when a
 * buffer is finished or when a new begins, and must be told so
 * separately. Allocated buffers will be zeroed, but may optionally be
 * reduced to their defaults (signalled by reallocating each non-empty
 * buffer to a single byte). General settings are cleared optionally,
 * such as cache flushing. Buffer specific settings such as buffer
 * identifier are always cleared.
 *
 * Returns -1 if allocator complains during buffer reduction, 0 on
 * success.
 */
int flatcc_builder_custom_reset(flatcc_builder_t *B,
        int reduce_buffers, int set_defaults);

/*
 * Same as `flatcc_builder_custom_reset` with default arguments
 * where buffers are not reduced and default settings are not reset.
 */
int flatcc_builder_reset(flatcc_builder_t *B);

/**
 * Deallocates all memory by calling allocate with a zero size request
 * on each buffer, then zeroing the builder structure itself.
 */
void flatcc_builder_clear(flatcc_builder_t *B);

/**
 * Allocates to next higher power of 2 using system realloc and ignores
 * `alloc_context`. Only reduces size if a small subsequent increase in
 * size would not trigger a reallocation. `alloc_type` is used to
 * set minimum sizes. Hash tables are allocated to the exact requested
 * size. See also `alloc_fun`.
 */
int flatcc_builder_default_alloc(void *alloc_context,
        flatcc_iovec_t *b, size_t request, int zero_fill, int alloc_type);

/**
 * If non-zero, the vtable cache will get flushed whenever it reaches
 * the given limit at a point in time where more space is needed. The
 * limit is not exact as it is only tested when reallocation is
 * required.
 */
void flatcc_builder_set_vtable_cache_limit(flatcc_builder_t *B, size_t size);

/**
 * Manual flushing of vtable for long running tasks. Mostly used
 * internally to deal with nested buffers.
 */
void flatcc_builder_flush_vtable_cache(flatcc_builder_t *B);

/**
 * Low-level support function to aid in constructing nested buffers without
 * allocation. Not for regular use.
 *
 * Call where `start_buffer` would have been placed when using
 * `create_buffer` in a nested context. Save the return value on a stack
 * as argument to `pop_buffer_alignment`.
 *
 * The call resets the current derived buffer alignment so the nested
 * buffer will not be aligned to more than required.
 *
 * Often it will not be necessary to be so careful with alignment since
 * the alignment cannot be invalid by failing to use push and pop, but
 * for code generation it will ensure the correct result every time.
 */
uint16_t flatcc_builder_push_buffer_alignment(flatcc_builder_t *B);

/**
 * Low-level call.
 *
 * Call with the return value from push_buffer_alignment after a nested
 * `create_buffer_call`. The alignments merge back up in the buffer
 * hierarchy so the top level buffer gets the largest of all aligments.
 */
void flatcc_builder_pop_buffer_alignment(flatcc_builder_t *B, uint16_t buffer_align);

/**
 * This value may be of interest when the buffer has been ended, for
 * example when subsequently allocating memory for the buffer to ensure
 * that memory is properly aligned.
 */
uint16_t flatcc_builder_get_buffer_alignment(flatcc_builder_t *B);

/**
 * Level 0 means no buffer is started, otherwise it increments with
 * start calls and decrements with end calls (approximately for
 * optimized operations such as table vectors).
 *
 * If `max_level` has been set, `get_level` always returns a value <=
 * `max_level` provided no start call has failed.
 *
 * Level continues to increment inside nested buffers.
 */
int flatcc_builder_get_level(flatcc_builder_t *B);

/**
 * Setting the max level triggers a failure on start of new nestings
 * when the level is reached. May be used to protect recursive descend
 * parsers etc. or later buffer readers.
 *
 * The builder itself is not sensitive to depth, and the allocator is a
 * better way to protect resource abuse.
 *
 * `max_level` is not reset inside nested buffers.
 */
void flatcc_builder_set_max_level(flatcc_builder_t *B, int level);

/**
 * By default ordinary data such as tables are placed in front of
 * earlier produced content and vtables are placed at the very end thus
 * clustering vtables together. This can be disabled so all content is
 * placed in front. Nested buffers ignores this setting because they can
 * only place content in front because they cannot blend with the
 * containing buffers content. Clustering could be more cache friendly
 * and also enables pre-shipping of the vtables during transmission.
 */
void flatcc_builder_set_vtable_clustering(flatcc_builder_t *B, int enable);

/**
 * Sets a new user supplied refmap which maps source pointers to
 * references and returns the old refmap, or null. It is also
 * possible to disable an existing refmap by setting a null
 * refmap.
 *
 * A clone or pick operation may use this map when present,
 * depending on the data type. If a hit is found, the stored
 * reference will be used instead of performing a new clone or
 * pick operation. It is also possible to manually populate the
 * refmap. Note that the builder does not have a concept of
 * clone or pick - these are higher level recursive operations
 * to add data from one buffer to another - but such code may
 * rely on the builder to provide the current refmap during
 * recursive operations. For this reason, the builder makes no
 * calls to the refmap interface on its own - it just stores the
 * current refmap such that recursive operations can find it.
 *
 * Refmaps MUST be reset, replaced or disabled if a source
 * pointer may be reused for different purposes - for example if
 * repeatedly reading FlatBuffers into the same memory buffer
 * and performing a clone into a buffer under construction.
 * Refmaps may also be replaced if the same object is to be
 * cloned several times keeping the internal DAG structure
 * intact with every new clone being an independent object.
 *
 * Refmaps must also be replaced or disabled prior to starting a
 * nested buffer and after stopping it, or when cloning a object
 * as a nested root. THIS IS VERY EASY TO GET WRONG!  The
 * builder does a lot of bookkeeping for nested buffers but not
 * in this case. Shared references may happen and they WILL fail
 * verification and they WILL break when copying out a nested
 * buffer to somewhere else. The user_frame stack may be used
 * for pushing refmaps, but often user codes recursive stack
 * will work just as well.
 *
 * It is entirely optional to use refmaps when cloning - they
 * preserve DAG structure and may speed up operations or slow
 * them down, depending on the source material.
 *
 * Refmaps may consume a lot of space when large offset vectors
 * are cloned when these do not have significant shared
 * references. They may also be very cheap to use without any
 * dynamic allocation when objects are small and have at most a
 * few references.
 *
 * Refmaps only support init, insert, find, reset, clear but not
 * delete. There is a standard implementation in the runtime
 * source tree but it can easily be replaced compile time and it
 * may also be left out if unused. The builder wraps reset, insert,
 * and find so the user does not have to check if a refmap is
 * present but other operations must be done direcly on the
 * refmap.
 *
 * The builder wrapped refmap operations are valid on a null
 * refmap which will find nothing and insert nothing.
 *
 * The builder will reset the refmap during a builder reset and
 * clear the refmap during a builder clear operation. If the
 * refmap goes out of scope before that happens it is important
 * to call set_refmap with null and manually clear the refmap.
 */
static inline flatcc_refmap_t *flatcc_builder_set_refmap(flatcc_builder_t *B, flatcc_refmap_t *refmap)
{
    flatcc_refmap_t *refmap_old;

    refmap_old = B->refmap;
    B->refmap = refmap;
    return refmap_old;
}

/* Retrieves the current refmap, or null. */
static inline flatcc_refmap_t *flatcc_builder_get_refmap(flatcc_builder_t *B)
{
    return B->refmap;
}

/* Finds a reference, or a null reference if no refmap is active.  * */
static inline flatcc_builder_ref_t flatcc_builder_refmap_find(flatcc_builder_t *B, const void *src)
{
    return B->refmap ? flatcc_refmap_find(B->refmap, src) : flatcc_refmap_not_found;
}

/*
 * Inserts into the current refmap with the inseted ref upon
 * upon success, or not_found on failure (default 0), or just
 * returns ref if refmap is absent.
 *
 * Note that if an existing item exists, the ref is replaced
 * and the new, not the old, ref is returned.
 */
static inline flatcc_builder_ref_t flatcc_builder_refmap_insert(flatcc_builder_t *B, const void *src, flatcc_builder_ref_t ref)
{
    return B->refmap ? flatcc_refmap_insert(B->refmap, src, ref) : ref;
}

static inline void flatcc_builder_refmap_reset(flatcc_builder_t *B)
{
    if (B->refmap) flatcc_refmap_reset(B->refmap);
}


typedef uint16_t flatcc_builder_buffer_flags_t;
static const flatcc_builder_buffer_flags_t flatcc_builder_is_nested = 1;
static const flatcc_builder_buffer_flags_t flatcc_builder_with_size = 2;

/* The flag size in the API needs to match the internal size. */
static_assert(sizeof(flatcc_builder_buffer_flags_t) ==
              sizeof(((flatcc_builder_t *)0)->buffer_flags), "flag size mismatch");

/**
 * An alternative to start buffer, start struct/table ... end buffer.
 *
 * This call is mostly of interest as a means to quicly create a zero
 * allocation top-level buffer header following a call to create_struct,
 * or to create_vtable/create_table. For that, it is quite simple to
 * use. For general buffer construction without allocation, more care is
 * needed, as discussed below.
 *
 * If the content is created with `start/end_table` calls, or similar,
 * it is better to use `start/end_buffer` since stack allocation is used
 * anyway.
 *
 * The buffer alignment must be provided manually as it is not derived
 * from constructed content, unlike `start/end_buffer`. Typically
 * `align` would be same argument as provided to `create_struct`.
 * `get_buffer_alignment` may also used (note: `get_buffer_alignment`
 * may return different after the call because it will be updated with
 * the `block_align` argument to `create_buffer` but that is ok).
 *
 * The buffer may be constructed as a nested buffer with the `is_nested
 * = 1` flag. As a nested buffer a ubyte vector header is placed before
 * the aligned buffer header. A top-level buffer will normally have
 * flags set to 0.
 *
 * A top-level buffer may also be constructed with the `with_size = 2`
 * flag for top level buffers. It adds a size prefix similar to
 * `is_nested` but the size is part of the aligned buffer. A size
 * prefixed top level buffer must be accessed with a size prefix aware
 * reader, or the buffer given to a standard reader must point to after
 * the size field while keeping the buffer aligned to the size field
 * (this will depend on the readers API which may be an arbitrary other
 * language).
 *
 * If the `with_size` is used with the `is_nested` flag, the size is
 * added as usual and all fields remain aligned as before, but padding
 * is adjusted to ensure the buffer is aligned to the size field so
 * that, for example, the nested buffer with size can safely be copied
 * to a new memory buffer for consumption.
 *
 * Generally, references may only be used within the same buffer
 * context. With `create_buffer` this becomes less precise. The rule
 * here is that anything that would be valid with start/end_buffer
 * nestings is also valid when removing the `start_buffer` call and
 * replacing `end_buffer` with `create_buffer`.
 *
 * Note the additional burden of tracking buffer alignment manually -
 * To help with this use `push_buffer_alignment` where `start_buffer`
 * would have been placed, and  `pop_buffer_alignment after the
 * `create_buffer` call, and use `get_buffer_alignemnt` as described
 * above.
 *
 * `create_buffer` is not suitable as a container for buffers created
 * with `start/end_buffer` as these make assumptions about context that
 * create buffer does not provide. Also, there is no point in doing so,
 * since the idea of `create_buffer` is to avoid allocation in the first
 * place.
 */
flatcc_builder_ref_t flatcc_builder_create_buffer(flatcc_builder_t *B,
        const char identifier[FLATBUFFERS_IDENTIFIER_SIZE],
        uint16_t block_align,
        flatcc_builder_ref_t ref, uint16_t align, flatcc_builder_buffer_flags_t flags);

/**
 * Creates a struct within the current buffer without using any
 * allocation.
 *
 * The struct should be used as a root in the `end_buffer` call or as a
 * union value as there are no other ways to use struct while conforming
 * to the FlatBuffer format - noting that tables embed structs in their
 * own data area except in union fields.
 *
 * The struct should be in little endian format and follow the usual
 * FlatBuffers alignment rules, although this API won't care about what
 * is being stored.
 *
 * May also be used to simply emit a struct through the emitter
 * interface without being in a buffer and without being a valid
 * FlatBuffer.
 */
flatcc_builder_ref_t flatcc_builder_create_struct(flatcc_builder_t *B,
        const void *data, size_t size, uint16_t align);

/**
 * Starts a struct and returns a pointer that should be used immediately
 * to fill in the struct in protocol endian format, and when done,
 * `end_struct` should be called. The returned reference should be used
 * as argument to `end_buffer` or as a union value. See also
 * `create_struct`.
 */
void *flatcc_builder_start_struct(flatcc_builder_t *B,
        size_t size, uint16_t align);

/**
 * Return a pointer also returned at start struct, e.g. for endian
 * conversion.
 */
void *flatcc_builder_struct_edit(flatcc_builder_t *B);

/**
 * Emits the struct started by `start_struct` and returns a reference to
 * be used as root in an enclosing `end_buffer` call or as a union
 * value.  As mentioned in `create_struct`, these can also be used more
 * freely, but not while being conformant FlatBuffers.
 */
flatcc_builder_ref_t flatcc_builder_end_struct(flatcc_builder_t *B);

/**
 * The buffer always aligns to at least the offset size (typically 4)
 * and the internal alignment requirements of the buffer content which
 * is derived as content is added.
 *
 * In addition, block_align can be specified. This ensures the resulting
 * buffer is at least aligned to the block size and that the total size
 * is zero padded to fill a block multiple if necessary. Because the
 * emitter operates on a virtual address range before the full buffer is
 * aligned, it may have to make assumptions based on that: For example,
 * it may be processing encryption blocks in the fly, and the resulting
 * buffer should be aligned to the encryption block size, even if the
 * content is just a byte aligned struct. Block align helps ensure this.
 * If the block align as 1 there will be no attempt to zero pad at the
 * end, but the content may still warrant padding after the header. End
 * padding is only needed with clustered vtables (which is the default).
 *
 * `block_align` is allowed to be 0 meaning it will inherit from parent if
 * present, and otherwise it defaults to 1.
 *
 * The identifier may be null, and it may optionally be set later with
 * `set_identifier` before the `end_buffer` call.
 *
 * General note:
 *
 * Only references returned with this buffer as current (i.e. last
 * unended buffer) can be stored in other objects (tables, offset
 * vectors) also belonging to this buffer, or used as the root argument
 * to `end_buffer`. A reference may be stored at most once, and unused
 * references will result in buffer garbage. All calls must be balanced
 * around the respective start / end operations, but may otherwise nest
 * freely, including nested buffers. Nested buffers are supposed to be
 * stored in a table offset field to comply with FlatBuffers, but the
 * API does not place any restrictions on where references are stored,
 * as long as they are indicated as offset fields.
 *
 * All alignment in all API calls must be between 1 and 256 and must be a
 * power of 2. This is not checked. Only if explicitly documented can it
 * also be 0 for a default value.
 *
 * `flags` can be `with_size` but `is_nested` is derived from context
 * see also `create_buffer`.
 */
int flatcc_builder_start_buffer(flatcc_builder_t *B,
        const char identifier[FLATBUFFERS_IDENTIFIER_SIZE],
        uint16_t block_align, flatcc_builder_buffer_flags_t flags);

/**
 * The root object should be a struct or a table to conform to the
 * FlatBuffers format, but technically it can also be a vector or a
 * string, or even a child buffer (which is also vector as seen by the
 * buffer). The object must be created within the current buffer
 * context, that is, while the current buffer is the deepest nested
 * buffer on the stack.
 */
flatcc_builder_ref_t flatcc_builder_end_buffer(flatcc_builder_t *B, flatcc_builder_ref_t root);

/**
 * The embed buffer is mostly intended to add an existing buffer as a
 * nested buffer. The buffer will be wrapped in a ubyte vector such that
 * the buffer is aligned at vector start, after the size field.
 *
 * If `align` is 0 it will default to 8 so that all FlatBuffer numeric
 * types will be readable. NOTE: generally do not count on align 0 being
 * valid or even checked by the API, but in this case it may be
 * difficult to know the internal buffer alignment, and 1 would be the wrong
 * choice.
 *
 * If `block_align` is set (non-zero), the buffer is placed in an isolated
 * block multiple. This may cost up to almost 2 block sizes in padding.
 * If the `block_align` argument is 0, it inherits from the parent
 * buffer block_size, or defaults to 1.
 *
 * The `align` argument must be set to respect the buffers internal
 * alignment requirements, but if the buffer is smaller it will not be
 * padded to isolate the buffer. For example a buffer of with
 * `align = 64` and `size = 65` may share its last 64 byte block with
 * other content, but not if `block_align = 64`.
 *
 * Because the ubyte size field is not, by default, part of the aligned
 * buffer, significant space can be wasted if multiple blocks are added
 * in sequence with a large block size.
 *
 * In most cases the distinction between the two alignments is not
 * important, but it allows separate configuration of block internal
 * alignment and block size, which can be important for auto-generated
 * code that may know the alignment of the buffer, but not the users
 * operational requirements.
 *
 * If the buffer is embedded without a parent buffer, it will simply
 * emit the buffer through the emit interface, but may also add padding
 * up to block alignment. At top-level there will be no size field
 * header.
 *
 * If `with_size` flag is set, the buffer is aligned to size field and
 * the above note about padding space no longer applies. The size field
 * is added regardless. The `is_nested` flag has no effect since it is
 * impplied.
 */
flatcc_builder_ref_t flatcc_builder_embed_buffer(flatcc_builder_t *B,
        uint16_t block_align,
        const void *data, size_t size, uint16_t align, flatcc_builder_buffer_flags_t flags);

/**
 * Applies to the innermost open buffer. The identifier may be null or
 * contain all zero. Overrides any identifier given to the start buffer
 * call.
 */
void flatcc_builder_set_identifier(flatcc_builder_t *B,
        const char identifier[FLATBUFFERS_IDENTIFIER_SIZE]);

enum flatcc_builder_type {
    flatcc_builder_empty = 0,
    flatcc_builder_buffer,
    flatcc_builder_struct,
    flatcc_builder_table,
    flatcc_builder_vector,
    flatcc_builder_offset_vector,
    flatcc_builder_string,
    flatcc_builder_union_vector
};

/**
 * Returns the object type currently on the stack, for example if
 * needing to decide how to close a buffer. Because a table is
 * automatically added when starting a table buffer,
 * `flatcc_builder_table_buffer` should not normally be seen and the level
 * should be 2 before when closing a top-level table buffer, and 0
 * after. A `flatcc_builder_struct_buffer` will be visible at level 1.
 *
 */
enum flatcc_builder_type flatcc_builder_get_type(flatcc_builder_t *B);

/**
 * Similar to `get_type` but for a specific level. `get_type_at(B, 1)`
 * will return `flatcc_builder_table_buffer` if this is the root buffer
 * type. get_type_at(B, 0) is always `flatcc_builder_empty` and so are any
 * level above `get_level`.
 */
enum flatcc_builder_type flatcc_builder_get_type_at(flatcc_builder_t *B, int level);

/**
 * The user stack is available for custom data. It may be used as
 * a simple stack by extending or reducing the inner-most frame.
 *
 * A frame has a size and a location on the user stack. Entering
 * a frame ensures the start is aligned to sizeof(size_t) and
 * ensures the requested space is available without reallocation.
 * When exiting a frame, the previous frame is restored.
 *
 * A user frame works completely independently of the builders
 * frame stack for tracking tables vectors etc. and does not have
 * to be completely at exit, but obviously it is not valid to
 * exit more often the entered.
 *
 * The frame is zeroed when entered.
 *
 * Returns a non-zero handle to the user frame upon success or
 * 0 on allocation failure.
 */
size_t flatcc_builder_enter_user_frame(flatcc_builder_t *B, size_t size);

/**
 * Makes the parent user frame current, if any. It is not valid to call
 * if there isn't any current frame. Returns handle to parent frame if
 * any, or 0.
 */
size_t flatcc_builder_exit_user_frame(flatcc_builder_t *B);

/**
 * Exits the frame represented by the given handle. All more
 * recently entered frames will also be exited. Returns the parent
 * frame handle if any, or 0.
 */
size_t flatcc_builder_exit_user_frame_at(flatcc_builder_t *B, size_t handle);

/**
 * Returns a non-zero handle to the current inner-most user frame if
 * any, or 0.
 */
size_t flatcc_builder_get_current_user_frame(flatcc_builder_t *B);

/*
 * Returns a pointer to the user frame at the given handle. Any active
 * frame can be accessed in this manner but the pointer is invalidated
 * by user frame enter and exit operations.
 */
void *flatcc_builder_get_user_frame_ptr(flatcc_builder_t *B, size_t handle);

/**
 * Returns the size of the buffer and the logical start and end address
 * of with respect to the emitters address range. `end` - `start` also
 * yields the size. During construction `size` is the emitted number of
 * bytes and after buffer close it is the actual buffer size - by then
 * the start is also the return value of close buffer. End marks the end
 * of the virtual table cluster block.
 *
 * NOTE: there is no guarantee that all vtables end up in the cluster
 * block if there is placed a limit on the vtable size, or if nested
 * buffers are being used. On the other hand, if these conditions are
 * met, it is guaranteed that all vtables are present if the vtable
 * block is available (this depends on external transmission - the
 * vtables are always emitted before tables using them). In all cases
 * the vtables will behave as valid vtables in a flatbuffer.
 */
size_t flatcc_builder_get_buffer_size(flatcc_builder_t *B);

/**
 * Returns the reference to the start of the emitter buffer so far, or
 * in total after buffer end, in the virtual address range used
 * by the emitter. Start is also returned by buffer end.
 */
flatcc_builder_ref_t flatcc_builder_get_buffer_start(flatcc_builder_t *B);

/**
 * Returns the reference to the end of buffer emitted so far. When
 * clustering vtables, this is the end of tables, or after buffer end,
 * also zero padding if block aligned. If clustering is disabled, this
 * method will return 0 as the buffer only grows down then.
 */
flatcc_builder_ref_t flatcc_builder_get_buffer_mark(flatcc_builder_t *B);

/**
 * Creates the vtable in the current buffer context, somewhat similar to
 * how create_vector operates. Each call results in a new table even if
 * an identical has already been emitted.
 *
 * Also consider `create_cached_vtable` which will reuse existing
 * vtables.
 *
 * This is low-low-level function intended to support
 * `create_cached_vtable` or equivalent, and `create_table`, both of
 * which are normally used indirectly via `start_table`, `table_add`,
 * `table_add_offset`..., `table_end`.
 *
 * Creates a vtable as a verbatim copy. This means the vtable must
 * include the header fields containing the vtable size and the table
 * size in little endian voffset_t encoding followed by the vtable
 * entries in same encoding.
 *
 * The function may be used to copy vtables from other other buffers
 * since they are directly transferable.
 *
 * The returned reference is actually the emitted location + 1. This
 * ensures the vtable is not mistaken for error because 0 is a valid
 * vtable reference. `create_table` is aware of this and substracts one
 * before computing the final offset relative to the table. This also
 * means vtable references are uniquely identifiable by having the
 * lowest bit set.
 *
 * vtable references may be reused within the same buffer, not any
 * parent or other related buffer (technically this is possible though,
 * as long as it is within same builder context, but it will not construct
 * valid FlatBuffers because the buffer cannot be extracted in isolation).
 */
flatcc_builder_vt_ref_t flatcc_builder_create_vtable(flatcc_builder_t *B,
        const flatbuffers_voffset_t *vt,
        flatbuffers_voffset_t vt_size);

/**
 * Support function to `create_vtable`. See also the uncached version
 * `create_vtable`.
 *
 * Looks up the constructed vtable on the vs stack too see if it matches
 * a cached entry. If not, it emits a new vtable either at the end if
 * top-level and clustering is enabled, or at the front (always for
 * nested buffers).
 *
 * If the same vtable was already emitted in a different buffer, but not
 * in the current buffer, the cache entry will be reused, but a new
 * table will be emitted the first it happens in the same table.
 *
 * The returned reference is + 1 relative to the emitted address range
 * to identify it as a vtable and to avoid mistaking the valid 0
 * reference for an error (clustered vtables tend to start at the end at
 * the virtual address 0, and up).
 *
 * The hash function can be chosen arbitrarily but may result in
 * duplicate emitted vtables if different hash functions are being used
 * concurrently, such as mixing the default used by `start/end table`
 * with a custom function (this is not incorrect, it only increases the
 * buffer size and cache pressure).
 *
 * If a vtable has a unique ID by other means than hashing the content,
 * such as an integer id, and offset into another buffer, or a pointer,
 * a good hash may be multiplication by a 32-bit prime number. The hash
 * table is not very sensitive to collissions as it uses externally
 * chained hashing with move to front semantics.
 */
flatcc_builder_vt_ref_t flatcc_builder_create_cached_vtable(flatcc_builder_t *B,
        const flatbuffers_voffset_t *vt,
        flatbuffers_voffset_t vt_size, uint32_t vt_hash);

/*
 * Based on Knuth's prime multiplier.
 *
 * This is an incremental hash that is called with id and size of each
 * non-empty field, and finally with the two vtable header fields
 * when vtables are constructed via `table_add/table_add_offset`.
 *
 */
#ifndef FLATCC_SLOW_MUL
#ifndef FLATCC_BUILDER_INIT_VT_HASH
#define FLATCC_BUILDER_INIT_VT_HASH(hash) { (hash) = (uint32_t)0x2f693b52UL; }
#endif
#ifndef FLATCC_BUILDER_UPDATE_VT_HASH
#define FLATCC_BUILDER_UPDATE_VT_HASH(hash, id, offset) \
        { (hash) = (((((uint32_t)id ^ (hash)) * (uint32_t)2654435761UL)\
                ^ (uint32_t)(offset)) * (uint32_t)2654435761UL); }
#endif
#ifndef FLATCC_BUILDER_BUCKET_VT_HASH
#define FLATCC_BUILDER_BUCKET_VT_HASH(hash, width) (((uint32_t)(hash)) >> (32 - (width)))
#endif
#endif

/*
 * By default we use Bernsteins hash as fallback if multiplication is slow.
 *
 * This just have to be simple, fast, and work on devices without fast
 * multiplication. We are not too sensitive to collisions. Feel free to
 * experiment and replace.
 */
#ifndef FLATCC_BUILDER_INIT_VT_HASH
#define FLATCC_BUILDER_INIT_VT_HASH(hash) { (hash) = 5381; }
#endif
#ifndef FLATCC_BUILDER_UPDATE_VT_HASH
#define FLATCC_BUILDER_UPDATE_VT_HASH(hash, id, offset) \
        { (hash) = ((((hash) << 5) ^ (id)) << 5) ^ (offset); }
#endif
#ifndef FLATCC_BUILDER_BUCKET_VT_HASH
#define FLATCC_BUILDER_BUCKET_VT_HASH(hash, width) (((1 << (width)) - 1) & (hash))
#endif



/**
 * Normally use `start_table` instead of this call.
 *
 * This is a low-level call only intended for high-performance
 * applications that repeatedly churn about similar tables of known
 * layout, or as a support layer for other builders that maintain their
 * own allocation rather than using the stack of this builder.
 *
 * Creates a table from an already emitted vtable, actual data that is
 * properly aligned relative to data start and in little endian
 * encoding. Unlike structs, tables can have offset fields. These must
 * be stored as flatcc_builder_ref_t types (which have uoffset_t size) as
 * returned by the api in native encoding. The `offsets` table contain
 * voffsets relative to `data` start (this is different from how vtables
 * store offsets because they are relative to a table header). The
 * `offsets` table is only used temporarily to translate the stored
 * references and is not part of final buffer content. `offsets` may be
 * null if `offset_count` is 0. `align` should be the highest aligned
 * field in the table, but `size` need not be a multiple of `align`.
 * Aside from endian encoding, the vtable must record a table size equal
 * to `size + sizeof(flatbuffers_uoffset_t)` because it includes the
 * table header field size. The vtable is not accessed by this call (nor
 * is it available). Unlike other references, the vtable reference may
 * be shared between tables in the same buffer (not with any related
 * buffer such as a parent buffer).
 *
 * The operation will not use any allocation, but will update the
 * alignment of the containing buffer if any.
 *
 * Note: unlike other create calls, except `create_offset_vector`,
 * the source data is modified in order to translate references intok
 * offsets before emitting the table.
 */
flatcc_builder_ref_t flatcc_builder_create_table(flatcc_builder_t *B,
        const void *data, size_t size, uint16_t align,
        flatbuffers_voffset_t *offsets, int offset_count,
        flatcc_builder_vt_ref_t vt_ref);

/**
 * Starts a table, typically following a start_buffer call as an
 * alternative to starting a struct, or to create table fields to be
 * stored in a parent table, or in an offset vector.
 * A number of `table_add` and table_add_offset` call may be placed
 * before the `end_table` call. Struct fields should NOT use `struct`
 * related call (because table structs are in-place), rather they should
 * use the `table_add` call with the appropriate size and alignment.
 *
 * A table, like other reference returning calls, may also be started
 * outside a buffer if the buffer header and alignment is of no
 * interest to the application, for example as part of an externally
 * built buffer.
 *
 * `count` must be larger than the largest id used for this table
 * instance. Normally it is set to the number of fields defined in the
 * schema, but it may be less if memory is constrained and only few
 * fields with low valued id's are in use. The count can extended later
 * with `reserve_table` if necessary. `count` may be also be set to a
 * large enough value such as FLATBUFFERS_ID_MAX + 1 if memory is not a
 * concern (reserves about twice the maximum vtable size to track the
 * current vtable and voffsets where references must be translated to
 * offsets at table end). `count` may be zero if for example
 * `reserve_table` is being used.
 *
 * Returns -1 on error, 0 on success.
 */
int flatcc_builder_start_table(flatcc_builder_t *B, int count);

/**
 * Call before adding a field with an id that is not below the count set
 * at table start. Not needed in most cases. For performance reasons
 * the builder does not check all bounds all the the time, but the user
 * can do so if memory constraints prevent start_table from using a
 * conservative value. See also `table_start`.
 *
 * Note: this call has absolutely no effect on the table layout, it just
 * prevents internal buffer overruns.
 *
 * Returns -1 on error, 0 on success.
 */
int flatcc_builder_reserve_table(flatcc_builder_t *B, int count);

/**
 * Completes the table constructed on the internal stack including
 * emitting a vtable, or finding a matching vtable that has already been
 * emitted to the same buffer. (Vtables cannot be shared between
 * buffers, but they can between tables of the same buffer).
 *
 * Note: there is a considerable, but necessary, amount of bookkeeping
 * involved in constructing tables. The `create_table` call is much
 * faster, but it also expects a lot of work to be done already.
 *
 * Tables can be created with no fields added. This will result in an
 * empty vtable and a table with just a vtable reference. If a table is
 * used as a sub-table, such a table might also not be stored at all,
 * but we do not return a special reference for that, nor do we provide
 * and option to not create the table in this case. This may be
 * interpreted as the difference between a null table (not stored in
 * parent), and an empty table with a unique offset (and thus identity)
 * different from other empty tables.
 */
flatcc_builder_ref_t flatcc_builder_end_table(flatcc_builder_t *B);

/**
 * Optionally this method can be called just before `flatcc_builder_end_table`
 * to verify that all required fields have been set.
 * Each entry is a table field id.
 *
 * Union fields should use the type field when checking for presence and
 * may also want to check the soundness of the union field overall using
 * `check_union_field` with the id one higher than the type field id.
 *
 * This funcion is typically called by an assertion in generated builder
 * interfaces while release builds may want to avoid this performance
 * overhead.
 *
 * Returns 1 if all fields are matched, 0 otherwise.
 */
int flatcc_builder_check_required(flatcc_builder_t *B, const flatbuffers_voffset_t *required, int count);

/**
 * Same as `check_required` when called with a single element.
 *
 * Typically used when direct calls are more convenient than building an
 * array first. Useful when dealing with untrusted intput such as parsed
 * text from an external source.
 */
int flatcc_builder_check_required_field(flatcc_builder_t *B, flatbuffers_voffset_t id);

/**
 * Checks that a union field is valid.
 *
 * The criteria is:
 *
 * If the type field is not present (at id - 1), or it holds a zero value,
 * then the table field (at id) must be present.
 *
 * Generated builder code may be able to enforce valid unions without
 * this check by setting both type and table together, but e.g. parsers
 * may receive the type and the table independently and then it makes
 * sense to validate the union fields before table completion.
 *
 * Note that an absent union field is perfectly valid. If a union is
 * required, the type field (id - 1), should be checked separately
 * while the table field should only be checked here because it can
 * (and must) be absent when the type is NONE (= 0).
 */
int flatcc_builder_check_union_field(flatcc_builder_t *B, flatbuffers_voffset_t id);

/**
 * A struct, enum or scalar added should be stored in little endian in
 * the return pointer location. The pointer is short lived and will
 * not necessarily survive other builder calls.
 *
 * A union type field can also be set using this call. In fact, this is
 * the only way to deal with unions via this API. Consequently, it is
 * the users repsonsibility to ensure the appropriate type is added
 * at the next higher id.
 *
 * Null and default values:
 *
 * FlatBuffers does not officially  provide an option for null values
 * because it does not distinguish between default values and values
 * that are not present. At this api level, we do not deal with defaults
 * at all. Callee should test the stored value against the default value
 * and only add the field if it does not match the default. This only
 * applies to scalar and enum values. Structs cannot have defaults so
 * their absence means null, and strings, vectors and subtables do have
 * natural null values different from the empty object and empty objects
 * with different identity is also possible.
 *
 * To handle Null for scalars, the following approach is recommended:
 *
 * Provide a schema-specific `add` operation that only calls this
 * low-level add method if the default does not match, and also provide
 * another `set` operation that always stores the value, regardless of
 * default. For most readers this will be transparent, except for extra
 * space used, but for Null aware readers, these can support operations
 * to test for Null/default/other value while still supporting the
 * normal read operation that returns default when a value is absent
 * (i.e. Null).
 *
 * It is valid to call with a size of 0 - the effect being adding the
 * vtable entry. The call may also be dropped in this case to reduce
 * the vtable size - the difference will be in null detection.
 */
void *flatcc_builder_table_add(flatcc_builder_t *B, int id, size_t size, uint16_t align);

/**
 * Returns a pointer to the buffer holding the last field added. The
 * size argument must match the field size added. May, for example, be
 * used to perform endian conversion after initially updating field
 * as a native struct. Must be called before the table is ended.
 */
void *flatcc_builder_table_edit(flatcc_builder_t *B, size_t size);

/**
 * Similar to `table_add` but copies source data into the buffer before
 * it is returned. Useful when adding a larger struct already encoded in
 * little endian.
 */
void *flatcc_builder_table_add_copy(flatcc_builder_t *B, int id, const void *data, size_t size, uint16_t align);

/**
 * Add a string, vector, or sub-table depending on the type if the
 * field identifier. The offset ref obtained when the field object was
 * closed should be stored as is in the given pointer. The pointer
 * is only valid short term, so create the object before calling
 * add to table, but the owner table can be started earlier. Never mix
 * refs from nested buffers with parent buffers.
 *
 * Also uses this method to add nested buffers. A nested buffer is
 * simple a buffer created while another buffer is open. The buffer
 * close operation provides the necessary reference.
 *
 * When the table closes, all references get converted into offsets.
 * Before that point, it is not required that the offset is written
 * to.
 */
flatcc_builder_ref_t *flatcc_builder_table_add_offset(flatcc_builder_t *B, int id);

/*
 * Adds a union type and reference in a single operation and returns 0
 * on success. Stores the type field at `id - 1` and the value at
 * `id`. The `value` is a reference to a table, to a string, or to a
 * standalone `struct` outside the table.
 *
 * If the type is 0, the value field must also be 0.
 *
 * Unions can also be added as separate calls to the type and the offset
 * separately which can lead to better packing when the type is placed
 * together will other small fields.
 */
int flatcc_builder_table_add_union(flatcc_builder_t *B, int id,
        flatcc_builder_union_ref_t uref);

/*
 * Adds a union type vector and value vector in a single operations
 * and returns 0 on success.
 *
 * If both the type and value vector is null, nothing is added.
 * Otherwise both must be present and have the same length.
 *
 * Any 0 entry in the type vector must also have a 0 entry in
 * the value vector.
 */
int flatcc_builder_table_add_union_vector(flatcc_builder_t *B, int id,
        flatcc_builder_union_vec_ref_t uvref);
/**
 * Creates a vector in a single operation using an externally supplied
 * buffer. This completely bypasses the stack, but the size must be
 * known and the content must be little endian. Do not use for strings
 * and offset vectors. Other flatbuffer vectors could be used as a
 * source, but the length prefix is not required.
 *
 * Set `max_count` to `FLATBUFFERS_COUNT_MAX(elem_size)` before a call
 * to any string or vector operation to the get maximum safe vector
 * size, or use (size_t)-1 if overflow is not a concern.
 *
 * The max count property is a global property that remains until
 * explicitly changed.
 *
 * `max_count` is to prevent malicous or accidental overflow which is
 * difficult to detect by multiplication alone, depending on the type
 * sizes being used and having `max_count` thus avoids a division for
 * every vector created. `max_count` does not guarantee a vector will
 * fit in an empty buffer, it just ensures the internal size checks do
 * not overflow. A safe, sane limit woud be max_count / 4 because that
 * is half the maximum buffer size that can realistically be
 * constructed, corresponding to a vector size of `UOFFSET_MAX / 4`
 * which can always hold the vector in 1GB excluding the size field when
 * sizeof(uoffset_t) = 4.
 */
flatcc_builder_ref_t flatcc_builder_create_vector(flatcc_builder_t *B,
        const void *data, size_t count, size_t elem_size, uint16_t align, size_t max_count);

/**
 * Starts a vector on the stack.
 *
 * Do not use these calls for string or offset vectors, but do store
 * scalars, enums and structs, always in little endian encoding.
 *
 * Use `extend_vector` subsequently to add zero, one or more elements
 * at time.
 *
 * See `create_vector` for `max_count` argument (strings and offset
 * vectors have a fixed element size and does not need this argument).
 *
 * Returns 0 on success.
 */
int flatcc_builder_start_vector(flatcc_builder_t *B, size_t elem_size,
        uint16_t align, size_t max_count);

/**
 * Emits the vector constructed on the stack by start_vector.
 *
 * The vector may be accessed in the emitted stream using the returned
 * reference, even if the containing buffer is still under construction.
 * This may be useful for sorting. This api does not support sorting
 * because offset vectors cannot read their references after emission,
 * and while plain vectors could be sorted, it has been chosen that this
 * task is better left as a separate processing step. Generated code can
 * provide sorting functions that work on final in-memory buffers.
 */
flatcc_builder_ref_t flatcc_builder_end_vector(flatcc_builder_t *B);

/** Returns the number of elements currently on the stack. */
size_t flatcc_builder_vector_count(flatcc_builder_t *B);

/**
 * Returns a pointer ot the first vector element on stack,
 * accessible up to the number of elements currently on stack.
 */
void *flatcc_builder_vector_edit(flatcc_builder_t *B);

/**
 * Returns a zero initialized buffer to a new region of the vector which
 * is extended at the end. The buffer must be consumed before other api
 * calls that may affect the stack, including `extend_vector`.
 *
 * Do not use for strings, offset or union vectors. May be used for nested
 * buffers, but these have dedicated calls to provide better alignment.
 */
void *flatcc_builder_extend_vector(flatcc_builder_t *B, size_t count);

/**
 * A specialized `vector_extend` that pushes a single element.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error. Note: for structs, care must be taken to ensure
 * the source has been zero padded. For this reason it may be better to
 * use extend(B, 1) and assign specific fields instead.
 */
void *flatcc_builder_vector_push(flatcc_builder_t *B, const void *data);

/**
 * Pushes multiple elements at a time.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
void *flatcc_builder_append_vector(flatcc_builder_t *B, const void *data, size_t count);

/**
 * Removes elements already added to vector that has not been ended.
 * For example, a vector of parsed list may remove the trailing comma,
 * or the vector may simply overallocate to get some temporary working
 * space. The total vector size must never become negative.
 *
 * Returns -1 if the count as larger than current count, or 0 on success.
 */
int flatcc_builder_truncate_vector(flatcc_builder_t *B, size_t count);

/*
 * Similar to `create_vector` but with references that get translated
 * into offsets. The references must, as usual, belong to the current
 * buffer. Strings, scalar and struct vectors can emit directly without
 * stack allocation, but offset vectors must translate the offsets
 * and therefore need the temporary space. Thus, this function is
 * roughly equivalent to to start, append, end offset vector.
 *
 * See also `flatcc_builder_create_offset_vector_direct`.
 */
flatcc_builder_ref_t flatcc_builder_create_offset_vector(flatcc_builder_t *B,
        const flatcc_builder_ref_t *data, size_t count);

/*
 * NOTE: this call takes non-const source array of references
 * and destroys the content.
 *
 * This is a faster version of `create_offset_vector` where the
 * source references are destroyed. In return the vector can be
 * emitted directly without passing over the stack.
 */
flatcc_builder_ref_t flatcc_builder_create_offset_vector_direct(flatcc_builder_t *B,
        flatcc_builder_ref_t *data, size_t count);


/**
 * Starts a vector holding offsets to tables or strings. Before
 * completion it will hold `flatcc_builder_ref_t` references because the
 * offset is not known until the vector start location is known, which
 * depends to the final size, which for parsers is generally unknown.
 */
int flatcc_builder_start_offset_vector(flatcc_builder_t *B);

/**
 * Similar to `end_vector` but updates all stored references so they
 * become offsets to the vector start.
 */
flatcc_builder_ref_t flatcc_builder_end_offset_vector(flatcc_builder_t *B);

/**
 * Same as `flatcc_builder_end_offset_vector` except null references are
 * permitted when the corresponding `type` entry is 0 (the 'NONE' type).
 * This makes it possible to build union vectors with less overhead when
 * the `type` vector is already known. Use standand offset vector calls
 * prior to this call.
 */
flatcc_builder_ref_t flatcc_builder_end_offset_vector_for_unions(flatcc_builder_t *B,
        const flatcc_builder_utype_t *type);

/** Returns the number of elements currently on the stack. */
size_t flatcc_builder_offset_vector_count(flatcc_builder_t *B);

/**
 * Returns a pointer ot the first vector element on stack,
 * accessible up to the number of elements currently on stack.
 */
void *flatcc_builder_offset_vector_edit(flatcc_builder_t *B);

/**
 * Similar to `extend_vector` but returns a buffer indexable as
 * `flatcc_builder_ref_t` array. All elements must be set to a valid
 * unique non-null reference, but truncate and extend may be used to
 * perform edits. Unused references will leave garbage in the buffer.
 * References should not originate from any other buffer than the
 * current, including parents and nested buffers.  It is valid to reuse
 * references in DAG form when contained in the sammer, excluding any
 * nested, sibling or parent buffers.
 */
flatcc_builder_ref_t *flatcc_builder_extend_offset_vector(flatcc_builder_t *B, size_t count);

/** Similar to truncate_vector. */
int flatcc_builder_truncate_offset_vector(flatcc_builder_t *B, size_t count);

/**
 * A specialized extend that pushes a single element.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
flatcc_builder_ref_t *flatcc_builder_offset_vector_push(flatcc_builder_t *B,
        flatcc_builder_ref_t ref);

/**
 * Takes an array of refs as argument to do a multi push operation.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
flatcc_builder_ref_t *flatcc_builder_append_offset_vector(flatcc_builder_t *B,
        const flatcc_builder_ref_t *refs, size_t count);

/**
 * All union vector operations are like offset vector operations,
 * except they take a struct with a type and a reference rather than
 * just a reference. The finished union vector is returned as a struct
 * of two references, one for the type vector and one for the table offset
 * vector. Each reference goes to a separate table field where the type
 * offset vector id must be one larger than the type vector.
 */

/**
 * Creates a union vector which is in reality two vectors, a type vector
 * and an offset vector. Both vectors references are returned.
 */
flatcc_builder_union_vec_ref_t flatcc_builder_create_union_vector(flatcc_builder_t *B,
        const flatcc_builder_union_ref_t *urefs, size_t count);

/*
 * NOTE: this call takes non-const source array of references
 * and destroys the content. The type array remains intact.
 *
 * This is a faster version of `create_union_vector` where the source
 * references are destroyed and where the types are given in a separate
 * array. In return the vector can be emitted directly without passing
 * over the stack.
 *
 * Unlike `create_offset_vector` we do allow null references but only if
 * the union type is NONE (0).
 */
flatcc_builder_union_vec_ref_t flatcc_builder_create_union_vector_direct(flatcc_builder_t *B,
        const flatcc_builder_utype_t *types, flatcc_builder_ref_t *data, size_t count);

/*
 * Creates just the type vector part of a union vector. This is
 * similar to a normal `create_vector` call except that the size
 * and alignment are given implicitly. Can be used during
 * cloning or similar operations where the types are all given
 * but the values must be handled one by one as prescribed by
 * the type. The values can be added separately as an offset vector.
 */
flatcc_builder_ref_t flatcc_builder_create_type_vector(flatcc_builder_t *B,
        const flatcc_builder_utype_t *types, size_t count);

/**
 * Starts a vector holding types and offsets to tables or strings. Before
 * completion it will hold `flatcc_builder_union_ref_t` references because the
 * offset is not known until the vector start location is known, which
 * depends to the final size, which for parsers is generally unknown,
 * and also because the union type must be separated out into a separate
 * vector. It would not be practicaly to push on two different vectors
 * during construction.
 */
int flatcc_builder_start_union_vector(flatcc_builder_t *B);

/**
 * Similar to `end_vector` but updates all stored references so they
 * become offsets to the vector start and splits the union references
 * into a type vector and an offset vector.
 */
flatcc_builder_union_vec_ref_t flatcc_builder_end_union_vector(flatcc_builder_t *B);

/** Returns the number of elements currently on the stack. */
size_t flatcc_builder_union_vector_count(flatcc_builder_t *B);

/**
 * Returns a pointer ot the first vector element on stack,
 * accessible up to the number of elements currently on stack.
 */
void *flatcc_builder_union_vector_edit(flatcc_builder_t *B);

/**
 * Similar to `extend_offset_vector` but returns a buffer indexable as a
 * `flatcc_builder_union_ref_t` array. All elements must be set to a valid
 * unique non-null reference with a valid union type to match, or it
 * must be null with a zero union type.
 */
flatcc_builder_union_ref_t *flatcc_builder_extend_union_vector(flatcc_builder_t *B, size_t count);

/** Similar to truncate_vector. */
int flatcc_builder_truncate_union_vector(flatcc_builder_t *B, size_t count);

/**
 * A specialized extend that pushes a single element.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
flatcc_builder_union_ref_t *flatcc_builder_union_vector_push(flatcc_builder_t *B,
        flatcc_builder_union_ref_t uref);

/**
 * Takes an array of union_refs as argument to do a multi push operation.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
flatcc_builder_union_ref_t *flatcc_builder_append_union_vector(flatcc_builder_t *B,
        const flatcc_builder_union_ref_t *urefs, size_t count);

/**
 * Faster string operation that avoids temporary stack storage. The
 * string is not required to be zero-terminated, but is expected
 * (unchecked) to be utf-8. Embedded zeroes would be allowed but
 * ubyte vectors should be used for that. The resulting string will
 * have a zero termination added, not included in length.
 */
flatcc_builder_ref_t flatcc_builder_create_string(flatcc_builder_t *B,
        const char *s, size_t len);

/** `create_string` up to zero termination of source. */
flatcc_builder_ref_t flatcc_builder_create_string_str(flatcc_builder_t *B,
        const char *s);

/**
 * `create_string` up to zero termination or at most max_len of source.
 *
 * Note that like `strncpy` it will include `max_len` characters if
 * the source is longer than `max_len`, but unlike `strncpy` it will
 * always add zero termination.
 */
flatcc_builder_ref_t flatcc_builder_create_string_strn(flatcc_builder_t *B, const char *s, size_t max_len);

/**
 * Starts an empty string that can be extended subsequently.
 *
 * While the string is being created, it is guaranteed that there is
 * always a null character after the end of the current string length.
 * This also holds after `extend` and `append` operations. It is not
 * allowed to modify the null character.
 *
 * Returns 0 on success.
 */
int flatcc_builder_start_string(flatcc_builder_t *B);

/**
 * Similar to `extend_vector` except for the buffer return type and a
 * slight speed advantage. Strings are expected to contain utf-8 content
 * but this isn't verified, and null characters would be accepted. The
 * length is given in bytes.
 *
 * Appending too much, then truncating can be used to trim string
 * escapes during parsing, or convert between unicode formats etc.
 */
char *flatcc_builder_extend_string(flatcc_builder_t *B, size_t len);

/**
 * Concatenes a length of string. If the string contains zeroes (which
 * it formally shouldn't), they will be copied in.
 *
 * Returns the buffer holding a modifiable copy of the added content,
 * or null on error.
 */
char *flatcc_builder_append_string(flatcc_builder_t *B, const char *s, size_t len);

/** `append_string` up to zero termination of source. */
char *flatcc_builder_append_string_str(flatcc_builder_t *B, const char *s);

/** `append_string` up zero termination or at most max_len of source. */
char *flatcc_builder_append_string_strn(flatcc_builder_t *B, const char *s, size_t max_len);

/**
 * Similar to `truncate_vector` available for consistency and a slight
 * speed advantage. Reduces string by `len` bytes - it does not set
 * the length. The resulting length must not become negative. Zero
 * termination is not counted.
 *
 * Returns -1 of the length becomes negative, 0 on success.
 */
int flatcc_builder_truncate_string(flatcc_builder_t *B, size_t len);

/**
 * Similar to `end_vector` but adds a trailing zero not included
 * in the length. The trailing zero is added regardless of whatever
 * zero content may exist in the provided string (although it
 * formally should not contain any).
 */
flatcc_builder_ref_t flatcc_builder_end_string(flatcc_builder_t *B);

/** Returns the length of string currently on the stack. */
size_t flatcc_builder_string_len(flatcc_builder_t *B);

/**
 * Returns a ponter to the start of the string
 * accessible up the length of string currently on the stack.
 */
char *flatcc_builder_string_edit(flatcc_builder_t *B);


/*
 * Only for use with the default emitter.
 *
 * Fast acces to small buffers from default emitter.
 *
 * Only valid for default emitters before `flatcc_builder_clear`. The
 * return buffer is not valid after a call to `flatcc_builder_reset` or
 * `flatcc_builder_clear`.
 *
 * Returns null if the buffer size is too large to a have a linear
 * memory representation or if the emitter is not the default. A valid
 * size is between half and a full emitter page size depending on vtable
 * content.
 *
 * Non-default emitters must be accessed by means specific to the
 * particular emitter.
 *
 * If `size_out` is not null, it is set to the buffer size, or 0 if
 * operation failed.
 *
 * The returned buffer should NOT be deallocated explicitly.
 *
 * The buffer size is the size reported by `flatcc_builder_get_buffer_size`.
 */
void *flatcc_builder_get_direct_buffer(flatcc_builder_t *B, size_t *size_out);

/*
 * Only for use with the default emitter.
 *
 * Default finalizer that allocates a buffer from the default emitter.
 *
 * Returns null if memory could not be allocated or if the emitter is
 * not the default. This is just a convenience method - there are many
 * other possible ways to extract the result of the emitter depending on
 * use case.
 *
 * If `size_out` is not null, it is set to the buffer size, or 0 if
 * operation failed.
 *
 * The allocated buffer is aligned according to malloc which may not be
 * sufficient in advanced cases - for that purpose
 * `flatcc_builder_finalize_aligned_buffer` may be used.
 *
 * It may be worth calling `flatcc_builder_get_direct_buffer` first to see
 * if the buffer is small enough to avoid copying.
 *
 * The returned buffer must be deallocated using `free`.
 */
void *flatcc_builder_finalize_buffer(flatcc_builder_t *B, size_t *size_out);

/*
 * Only for use with the default emitter.
 *
 * Similar to `flatcc_builder_finalize_buffer` but ensures the returned
 * memory is aligned to the overall alignment required for the buffer.
 * Often it is not necessary unless special operations rely on larger
 * alignments than the stored scalars.
 *
 * If `size_out` is not null, it is set to the buffer size, or 0 if
 * operation failed.
 *
 * The returned buffer must be deallocated using `aligned_free` which is
 * implemented via `flatcc_flatbuffers.h`. `free` will usually work but
 * is not portable to platforms without posix_memalign or C11
 * aligned_alloc support.
 *
 * NOTE: if a library might be compiled with a version of aligned_free
 * that differs from the application using it, use
 * `flatcc_builder_aligned_free` to make sure the correct deallocation
 * function is used.
 */
void *flatcc_builder_finalize_aligned_buffer(flatcc_builder_t *B, size_t *size_out);

/*
 * A stable implementation of `aligned_alloc` that is not sensitive
 * to the applications compile time flags.
 */
void *flatcc_builder_aligned_alloc(size_t alignment, size_t size);

/*
 * A stable implementation of `aligned_free` that is not sensitive
 * to the applications compile time flags.
 */
void flatcc_builder_aligned_free(void *p);

/*
 * Same allocation as `flatcc_builder_finalize_buffer` returnes. Usually
 * same as `malloc` but can redefined via macros.
 */
void *flatcc_builder_alloc(size_t size);

/*
 * A stable implementation of `free` when the default allocation
 * methods have been redefined.
 *
 * Deallocates memory returned from `flatcc_builder_finalize_buffer`.
 */
void flatcc_builder_free(void *p);

/*
 * Only for use with the default emitter.
 *
 * Convenience method to copy buffer from default emitter. Forwards
 * call to default emitter and returns input pointer, or null if
 * the emitter is not default or of the given size is smaller than
 * the buffer size.
 *
 * Note: the `size` argument is the target buffers capacity, not the
 * flatcc_builders buffer size.
 *
 * Other emitters have custom interfaces for reaching their content.
 */
void *flatcc_builder_copy_buffer(flatcc_builder_t *B, void *buffer, size_t size);

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_BUILDER_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_emitter_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_emitter_h
#ifndef FLATCC_EMITTER_H
#define FLATCC_EMITTER_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Default implementation of a flatbuilder emitter.
 *
 * This may be used as a starting point for more advanced emitters,
 * for example writing completed pages to disk or network and
 * the recycling those pages.
 */

#include <stdlib.h>
#include <string.h>
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_iov_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_iov_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h

/*
 * The buffer steadily grows during emission but the design allows for
 * an extension where individual pages can recycled before the buffer
 * is complete, for example because they have been transmitted.
 *
 * When done, the buffer can be cleared to free all memory, or reset to
 * maintain an adaptive page pool for next buffer construction.
 *
 * Unlike an exponentially growing buffer, each buffer page remains
 * stable in memory until reset, clear or recycle is called.
 *
 * Design notes for possible extensions:
 *
 * The buffer is a ring buffer marked by a front and a back page. The
 * front and back may be the same page and may initially be absent.
 * Anything outside these pages are unallocated pages for recycling.
 * Any page between (but excluding) the front and back pages may be
 * recycled by unlinking and relinking outside the front and back pages
 * but then copy operations no longer makes sense. Each page stores the
 * logical offset within the buffer but isn't otherwise used by the
 * implemention - it might be used for network transmission.  The buffer
 * is not explicitly designed for multithreaded access but any page
 * strictly between front and back is not touched unless recycled and in
 * this case aligned allocation is useful to prevent cache line sharing.
 */

/*
 * Memory is allocated in fixed length page units - the first page is
 * split between front and back so each get half the page size. If the
 * size is a multiple of 128 then each page offset will be a multiple of
 * 64, which may be useful for sequencing etc.
 */
#ifndef FLATCC_EMITTER_PAGE_SIZE
#define FLATCC_EMITTER_MAX_PAGE_SIZE 3000
#define FLATCC_EMITTER_PAGE_MULTIPLE 64
#define FLATCC_EMITTER_PAGE_SIZE ((FLATCC_EMITTER_MAX_PAGE_SIZE) &\
    ~(2 * (FLATCC_EMITTER_PAGE_MULTIPLE) - 1))
#endif

#ifndef FLATCC_EMITTER_ALLOC
#ifdef FLATCC_EMITTER_USE_ALIGNED_ALLOC
/*
 * <stdlib.h> does not always provide aligned_alloc, so include whatever
 * is required when enabling this feature.
 */
#define FLATCC_EMITTER_ALLOC(n) aligned_alloc(FLATCC_EMITTER_PAGE_MULTIPLE,\
        (((n) + FLATCC_EMITTER_PAGE_MULTIPLE - 1) & ~(FLATCC_EMITTER_PAGE_MULTIPLE - 1)))
#ifndef FLATCC_EMITTER_FREE
#define FLATCC_EMITTER_FREE(p) aligned_free(p)
#endif
#endif
#endif

#ifndef FLATCC_EMITTER_ALLOC
#define FLATCC_EMITTER_ALLOC(n) FLATCC_ALLOC(n)
#endif
#ifndef FLATCC_EMITTER_FREE
#define FLATCC_EMITTER_FREE(p) FLATCC_FREE(p)
#endif

typedef struct flatcc_emitter_page flatcc_emitter_page_t;
typedef struct flatcc_emitter flatcc_emitter_t;

struct flatcc_emitter_page {
    uint8_t page[FLATCC_EMITTER_PAGE_SIZE];
    flatcc_emitter_page_t *next;
    flatcc_emitter_page_t *prev;
    /*
     * The offset is relative to page start, but not necessarily
     * to any present content if part of front or back page,
     * and undefined for unused pages.
     */
    flatbuffers_soffset_t page_offset;
};

/*
 * Must be allocated and zeroed externally, e.g. on the stack
 * then provided as emit_context to the flatbuilder along
 * with the `flatcc_emitter` function.
 */
struct flatcc_emitter {
    flatcc_emitter_page_t *front, *back;
    uint8_t *front_cursor;
    size_t front_left;
    uint8_t *back_cursor;
    size_t back_left;
    size_t used;
    size_t capacity;
    size_t used_average;
};

/* Optional helper to ensure emitter is zeroed initially. */
static inline void flatcc_emitter_init(flatcc_emitter_t *E)
{
    memset(E, 0, sizeof(*E));
}

/* Deallocates all buffer memory making the emitter ready for next use. */
void flatcc_emitter_clear(flatcc_emitter_t *E);

/*
 * Similar to `clear_flatcc_emitter` but heuristacally keeps some allocated
 * memory between uses while gradually reducing peak allocations.
 * For small buffers, a single page will remain available with no
 * additional allocations or deallocations after first use.
 */
void flatcc_emitter_reset(flatcc_emitter_t *E);

/*
 * Helper function that allows a page between front and back to be
 * recycled while the buffer is still being constructed - most likely as part
 * of partial copy or transmission. Attempting to recycle front or back
 * pages will result in an error. Recycling pages outside the
 * front and back will be valid but pointless. After recycling and copy
 * operations are no longer well-defined and should be replaced with
 * whatever logic is recycling the pages.  The reset operation
 * automatically recycles all (remaining) pages when emission is
 * complete. After recycling, the `flatcc_emitter_size` function will
 * return as if recycle was not called, but will only represent the
 * logical size, not the size of the active buffer. Because a recycled
 * page is fully utilized, it is fairly easy to compensate for this if
 * required.
 *
 * Returns 0 on success.
 */
int flatcc_emitter_recycle_page(flatcc_emitter_t *E, flatcc_emitter_page_t *p);

/*
 * The amount of data copied with `flatcc_emitter_copy_buffer` and related
 * functions. Normally called at end of buffer construction but is
 * always valid, as is the copy functions. The size is a direct
 * function of the amount emitted data so the flatbuilder itself can
 * also provide this information.
 */
static inline size_t flatcc_emitter_get_buffer_size(flatcc_emitter_t *E)
{
    return E->used;
}

/*
 * Returns buffer start iff the buffer fits on a single internal page.
 * Only useful for fairly small buffers - about half the page size since
 * one half of first page goes to vtables that likely use little space.
 * Returns null if request could not be served.
 *
 * If `size_out` is not null, it is set to the buffer size, or 0 if
 * operation failed.
 */
static inline void *flatcc_emitter_get_direct_buffer(flatcc_emitter_t *E, size_t *size_out)
{
    if (E->front == E->back) {
        if (size_out) {
            *size_out = E->used;
        }
        return E->front_cursor;
    }
    if (size_out) {
        *size_out = 0;
    }
    return 0;
}

/*
 * Copies the internal flatcc_emitter representation to an externally
 * provided linear buffer that must have size `flatcc_emitter_get_size`.
 *
 * If pages have been recycled, only the remaining pages will be copied
 * and thus less data than what `flatcc_emitter_get_size` would suggest. It
 * makes more sense to provide a customized copy operation when
 * recycling pages.
 *
 * If the buffer is too small, nothing is copied, otherwise the
 * full buffer is copied and the input buffer is returned.
 */
void *flatcc_emitter_copy_buffer(flatcc_emitter_t *E, void *buf, size_t size);

/*
 * The emitter interface function to the flatbuilder API.
 * `emit_context` should be of type `flatcc_emitter_t` for this
 * particular implementation.
 *
 * This function is compatible with the `flatbuilder_emit_fun`
 * type defined in "flatbuilder.h".
 */
int flatcc_emitter(void *emit_context,
        const flatcc_iovec_t *iov, int iov_count,
        flatbuffers_soffset_t offset, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_EMITTER_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_endian_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_endian_h
#ifndef FLATCC_ENDIAN_H
#define FLATCC_ENDIAN_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * This file provides helper macros to define type-specific macros and
 * inline functions that convert between stored data and native data
 * indedpently of both native (host) endianness and protocol endianness
 * (i.e. the serialized endian format).
 *
 * To detect endianness correctly ensure one of the following is defined.
 *
 *     __LITTLE_ENDIAN__
 *     __BIG_ENDIAN__
 *     FLATBUFFERS_LITTLEENDIAN=1
 *     FLATBUFFERS_LITTLEENDIAN=0
 *
 * Note: the Clang compiler likely already does this, but other
 * compilers may have their own way, if at all.
 *
 * It is also necessary to include <endian.h> or a compatible
 * implementation in order to provide:
 *
 *     le16toh, le32to, le64toh, be16toh, be32toh, be64toh,
 *     htole16, htole32, htole64, htobe16, htobe32, htobe64.
 *
 * A simple way to ensure all of the above for most platforms is
 * to include the portable endian support file:
 *
 *     #include "flatcc/portable/pendian.h"
 *
 * It is also necessary to include
 *
 *      #include "flatcc/flatcc_types.h"
 *
 * or an equivalent file. This makes it possible to change the
 * endianness of the serialized data and the sizes of flatbuffer
 * specific types such as `uoffset_t`.
 *
 * Note: the mentioned include files are likely already included
 * by the file including this file, at least for the default
 * configuration.
 */

#ifndef UINT8_MAX
#include <stdint.h>
#endif

/* These are needed to simplify accessor macros and are not found in <endian.h>. */
#ifndef le8toh
#define le8toh(n) (n)
#endif

#ifndef be8toh
#define be8toh(n) (n)
#endif

#ifndef htole8
#define htole8(n) (n)
#endif

#ifndef htobe8
#define htobe8(n) (n)
#endif
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_accessors_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_accessors_h

/* This is the binary encoding endianness, usually LE for flatbuffers. */
#if FLATBUFFERS_PROTOCOL_IS_LE
#define flatbuffers_endian le
#elif FLATBUFFERS_PROTOCOL_IS_BE
#define flatbuffers_endian be
#else
#error "flatbuffers has no defined endiannesss"
#endif

 __flatcc_define_basic_scalar_accessors(flatbuffers_, flatbuffers_endian)

 __flatcc_define_integer_accessors(flatbuffers_bool, flatbuffers_bool_t,
         FLATBUFFERS_BOOL_WIDTH, flatbuffers_endian)
 __flatcc_define_integer_accessors(flatbuffers_union_type, flatbuffers_union_type_t,
         FLATBUFFERS_UTYPE_WIDTH, flatbuffers_endian)

 __flatcc_define_integer_accessors(__flatbuffers_uoffset, flatbuffers_uoffset_t,
         FLATBUFFERS_UOFFSET_WIDTH, flatbuffers_endian)
 __flatcc_define_integer_accessors(__flatbuffers_soffset, flatbuffers_soffset_t,
         FLATBUFFERS_SOFFSET_WIDTH, flatbuffers_endian)
 __flatcc_define_integer_accessors(__flatbuffers_voffset, flatbuffers_voffset_t,
         FLATBUFFERS_VOFFSET_WIDTH, flatbuffers_endian)
 __flatcc_define_integer_accessors(__flatbuffers_utype, flatbuffers_utype_t,
         FLATBUFFERS_UTYPE_WIDTH, flatbuffers_endian)
 __flatcc_define_integer_accessors(__flatbuffers_thash, flatbuffers_thash_t,
         FLATBUFFERS_THASH_WIDTH, flatbuffers_endian)

/* flatcc/portable/pendian.h sets LITTLE/BIG flags if possible, and always defines le16toh. */
#ifndef flatbuffers_is_native_pe
#if defined(__LITTLE_ENDIAN__) || FLATBUFFERS_LITTLEENDIAN
#undef FLATBUFFERS_LITTLEENDIAN
#define FLATBUFFERS_LITTLEENDIAN 1
#define flatbuffers_is_native_pe() (FLATBUFFERS_PROTOCOL_IS_LE)
#elif defined(__BIG_ENDIAN__) || (defined(FLATBUFFERS_LITTLEENDIAN) && !FLATBUFFERS_LITTLEENDIAN)
#undef FLATBUFFERS_LITTLEENDIAN
#define FLATBUFFERS_LITTLEENDIAN 0
#define flatbuffers_is_native_pe() (FLATBUFFERS_PROTOCOL_IS_BE)
#else
#define flatbuffers_is_native_pe() (__FLATBUFFERS_CONCAT(flatbuffers_endian, 16toh)(1) == 1)
#endif
#endif

#ifndef flatbuffers_is_native_le
#define flatbuffers_is_native_le() flatbuffers_is_native_pe()
#endif

#ifndef flatbuffers_is_native_be
#define flatbuffers_is_native_be() (!flatbuffers_is_native_pe())
#endif

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_ENDIAN_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_epilogue_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_epilogue_h
/* Include guard intentionally left out. */

#ifdef __cplusplus
}
#endif
#define JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_pop_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_pop_h
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_flatbuffers_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_flatbuffers_h
/*
 * Even C11 compilers depend on clib support for `static_assert` which
 * isn't always present, so we deal with this here for all compilers.
 *
 * Outside include guard to handle scope counter.
 */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h

#ifndef FLATCC_FLATBUFFERS_H
#define FLATCC_FLATBUFFERS_H

#ifdef __cplusplus
extern "C" {
#endif

#ifndef flatcc_flatbuffers_defined
#define flatcc_flatbuffers_defined

#ifdef FLATCC_PORTABLE
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_portable_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_portable_h
#endif
#define JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h
/* Needed by C99 compilers without FLATCC_PORTABLE. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h

/* Handle fallthrough attribute in switch statements. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pattributes_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pattributes_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_alloc_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_assert_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_assert_h

#define __FLATBUFFERS_PASTE2(a, b) a ## b
#define __FLATBUFFERS_PASTE3(a, b, c) a ## b ## c
#define __FLATBUFFERS_CONCAT(a, b) __FLATBUFFERS_PASTE2(a, b)

/*
 * "flatcc_endian.h" requires the preceeding include files,
 * or compatible definitions.
 */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h
/* Needed by flatcc_accessors.h to handle strict aliasing rules. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_endian_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_endian_h
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_identifier_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_identifier_h

#ifndef FLATBUFFERS_WRAP_NAMESPACE
#define FLATBUFFERS_WRAP_NAMESPACE(ns, x) ns ## _ ## x
#endif

#endif /* flatcc_flatbuffers_defined */

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_FLATBUFFERS_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_identifier_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_identifier_h
#ifndef FLATCC_IDENTIFIER_H
#define FLATCC_IDENTIFIER_H

#ifdef __cplusplus
extern "C" {
#endif

#ifndef FLATCC_FLATBUFFERS_H
#error "include via flatcc/flatcc_flatbuffers.h"
#endif

#ifndef UINT8_MAX
#include <stdint.h>
#endif

/*
 * FlatBuffers identifiers are normally specified by "file_identifer" in
 * the schema, but a standard hash of the fully qualified type name can
 * also be used. This file implements such a mapping, but the generated
 * headers also contain the necessary information for known types.
 */


/*
 * Returns the type hash of a given name in native endian format.
 * Generated code already provides these, but if a name was changed
 * in the schema it may be relevant to recompute the hash manually.
 *
 * The wire-format of this value should always be little endian.
 *
 * Note: this must be the fully qualified name, e.g. in the namespace
 * "MyGame.Example":
 *
 *     flatbuffers_type_hash_from_name("MyGame.Example.Monster");
 *
 * or, in the global namespace just:
 *
 *     flatbuffers_type_hash_from_name("MyTable");
 *
 * This assumes 32 bit hash type. For other sizes, other FNV-1a
 * constants would be required.
 *
 * Note that we reserve hash value 0 for missing or ignored value.
 */
static inline flatbuffers_thash_t flatbuffers_type_hash_from_name(const char *name)
{
    uint32_t hash = UINT32_C(2166136261);
    while (*name) {
        hash ^= (unsigned char)*name;
        hash = hash * UINT32_C(16777619);
        ++name;
    }
    if (hash == 0) {
        hash = UINT32_C(2166136261);
    }
    return hash;
}

/*
 * Type hash encoded as little endian file identifier string.
 * Note: if type hash is 0, the identifier should be null which
 * we cannot return in this interface.
 */
static inline void flatbuffers_identifier_from_type_hash(flatbuffers_thash_t type_hash, flatbuffers_fid_t out_identifier)
{
    out_identifier[0] = (char)(type_hash & 0xff);
    type_hash >>= 8;
    out_identifier[1] = (char)(type_hash & 0xff);
    type_hash >>= 8;
    out_identifier[2] = (char)(type_hash & 0xff);
    type_hash >>= 8;
    out_identifier[3] = (char)(type_hash & 0xff);
}

/* Native integer encoding of file identifier. */
static inline flatbuffers_thash_t flatbuffers_type_hash_from_identifier(const flatbuffers_fid_t identifier)
{
    uint8_t *p = (uint8_t *)identifier;

    return identifier ?
        (uint32_t)p[0] + (((uint32_t)p[1]) << 8) + (((uint32_t)p[2]) << 16) + (((uint32_t)p[3]) << 24) : 0;
}

/*
 * Convert a null terminated string identifier like "MONS" or "X" into a
 * native type hash identifier, usually for comparison. This will not
 * work with type hash strings because they can contain null bytes.
 */
static inline flatbuffers_thash_t flatbuffers_type_hash_from_string(const char *identifier)
{
    flatbuffers_thash_t h = 0;
    const uint8_t *p = (const uint8_t *)identifier;

    if (!p[0]) return h;
    h += ((flatbuffers_thash_t)p[0]);
    if (!p[1]) return h;
    h += ((flatbuffers_thash_t)p[1]) << 8;
    if (!p[2]) return h;
    h += ((flatbuffers_thash_t)p[2]) << 16;
    /* No need to test for termination here. */
    h += ((flatbuffers_thash_t)p[3]) << 24;
    return h;
}

/*
 * Computes the little endian wire format of the type hash. It can be
 * used as a file identifer argument to various flatcc buffer calls.
 *
 * `flatbuffers_fid_t` is just `char [4]` for the default flatbuffers
 * type system defined in `flatcc/flatcc_types.h`.
 */
static inline void flatbuffers_identifier_from_name(const char *name, flatbuffers_fid_t out_identifier)
{
    flatbuffers_identifier_from_type_hash(flatbuffers_type_hash_from_name(name), out_identifier);
}

/*
 * This is a collision free hash (a permutation) of the type hash to
 * provide better distribution for use in hash tables. It is likely not
 * necessary in praxis, and for uniqueness of identifiers it provides no
 * advantage over just using the FNV-1a type hash, except when truncating
 * the identifier to less than 32-bits.
 *
 * Note: the output should not be used in transmission. It provides no
 * additional information and just complicates matters. Furthermore, the
 * unmodified type hash has the benefit that it can seed a child namespace.
 */
static inline uint32_t flatbuffers_disperse_type_hash(flatbuffers_thash_t type_hash)
{
    /* http://stackoverflow.com/a/12996028 */
    uint32_t x = type_hash;

    x = ((x >> 16) ^ x) * UINT32_C(0x45d9f3b);
    x = ((x >> 16) ^ x) * UINT32_C(0x45d9f3b);
    x = ((x >> 16) ^ x);
    return x;
}


/* We have hardcoded assumptions about identifier size. */
static_assert(sizeof(flatbuffers_fid_t) == 4, "unexpected file identifier size");
static_assert(sizeof(flatbuffers_thash_t) == 4, "unexpected type hash size");

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_IDENTIFIER_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_iov_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_iov_h
#ifndef FLATCC_IOV_H
#define FLATCC_IOV_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdlib.h>

/*
 * The emitter receives one, or a few buffers at a time via
 * this type.  <sys/iov.h> compatible iovec structure used for
 * allocation and emitter interface.
 */
typedef struct flatcc_iovec flatcc_iovec_t;
struct flatcc_iovec {
    void *iov_base;
    size_t iov_len;
};

/*
 * The largest iovec vector the builder will issue. It will
 * always be a relatively small number.
 */
#define FLATCC_IOV_COUNT_MAX 8

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_IOV_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_portable_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_portable_h
#ifndef FLATCC_PORTABLE_H
#define FLATCC_PORTABLE_H

#ifdef __cplusplus
extern "C" {
#endif
#define JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_PORTABLE_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_prologue_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_prologue_h
/* Include guard intentionally left out. */

#define PDIAGNOSTIC_IGNORE_UNUSED
#define JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_push_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_push_h

#ifdef __cplusplus
extern "C" {
#endif
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_refmap_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_refmap_h
/*
 * The flatcc builder supports storing a pointer to a refmap
 * and wraps some operations to make them work as a dummy
 * even if no refmap has been set. This enables optional
 * DAG preservation possible during clone operations.
 *
 * A refmap maps a source address to a builder reference.
 *
 * This is just a map, but the semantics are important:
 *
 * The map thus preserves identity of the source. It is not a
 * cache because cache eviction would fail to properly track
 * identity.
 *
 * The map is used for memoization during object cloning are and
 * may also be used by user logic doing similar operations.
 * This ensures that identity is preserved so a source object is
 * not duplicated which could lead to either loss of semantic
 * information, or an explosion in size, or both. In some, or
 * even most, cases this concern may not be important, but when
 * it is important, it is important.
 *
 * The source address must not be reused for different content
 * for the lifetime of the map, although the content doest not
 * have to be valid or event exist at that location since source
 * address is just used as a key.
 *
 * The lifetime may be a single clone operation which then
 * tracks child object references as well, or it may be the
 * lifetime of the buffer builder.
 *
 * The map may be flushed explicitly when the source addresses
 * are no longer unique, such as when reusing a memory buffer,
 * and when identity preservation is no longer important.
 * Flushing a map is esentially the same as ending a lifetime.
 *
 * Multiple maps may exist concurrently for example if cloning
 * an object twice into two new objects that should have
 * separate identities. This is especially true and necessary
 * when creating a new nested buffer because the nested buffer
 * cannot share references with the parent. Cloning and object
 * that contains a nested buffer does not require multiple maps
 * because the nested buffer is then opaque.
 */

#ifndef FLATCC_REFMAP_H
#define FLATCC_REFMAP_H

#ifdef __cplusplus
extern "C" {
#endif
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h

#ifndef FLATCC_REFMAP_MIN_BUCKETS
/* 8 buckets gives us 5 useful initial entries with a load factor of 0.7 */
#define FLATCC_REFMAP_MIN_BUCKETS 8
#endif

#define FLATCC_REFMAP_LOAD_FACTOR 0.7f

typedef struct flatcc_refmap flatcc_refmap_t;
typedef flatbuffers_soffset_t flatcc_refmap_ref_t;

static const flatcc_refmap_ref_t flatcc_refmap_not_found = 0;

struct flatcc_refmap_item {
    const void *src;
    flatcc_refmap_ref_t ref;
};

struct flatcc_refmap {
    size_t count;
    size_t buckets;
    struct flatcc_refmap_item *table;
    /* Use stack allocation for small maps. */
    struct flatcc_refmap_item min_table[FLATCC_REFMAP_MIN_BUCKETS];
};

/*
 * Fast zero initialization - does not allocate any memory.
 * May be replaced by memset 0, but `init` avoids clearing the
 * stack allocated initial hash table until it is needed.
 */
static inline int flatcc_refmap_init(flatcc_refmap_t *refmap)
{
    refmap->count = 0;
    refmap->buckets = 0;
    refmap->table = 0;
    return 0;
}

/*
 * Removes all items and deallocates memory.
 * Not required unless `insert` or `resize` took place. The map can be
 * reused subsequently without calling `init`.
 */
void flatcc_refmap_clear(flatcc_refmap_t *refmap);

/*
 * Keeps allocated memory as is, but removes all items. The map
 * must intialized first.
 */
void flatcc_refmap_reset(flatcc_refmap_t *refmap);

/*
 * Returns the inserted reference if the `src` pointer was found,
 * without inspecting the content of the `src` pointer.
 *
 * Returns flatcc_refmap_not_found (default 0) if the `src` pointer was
 * not found.
 */
flatcc_refmap_ref_t flatcc_refmap_find(flatcc_refmap_t *refmap, const void *src);

/*
 * Inserts a `src` source pointer and its associated `ref` reference
 * into the refmap without inspecting the `src` pointer content. The
 * `ref` value will be replaced if the the `src` pointer already exists.
 *
 * Inserting null will just return the ref without updating the map.
 *
 * There is no delete operation which simplifies an open
 * addressing hash table, and it isn't needed for this use case.
 *
 * Returns the input ref or not_found on allocation error.
 */
flatcc_refmap_ref_t flatcc_refmap_insert(flatcc_refmap_t *refmap, const void *src, flatcc_refmap_ref_t ref);

/*
 * Set the hash table to accommodate at least `count` items while staying
 * within the predefined load factor.
 *
 * Resize is primarily an internal operation, but the user may resize
 * ahead of a large anticipated load, or after a large load to shrink
 * the table using 0 as the `count` argument. The table never shrinks
 * on its own account.
 */
int flatcc_refmap_resize(flatcc_refmap_t *refmap, size_t count);

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_REFMAP_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_rtconfig_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_rtconfig_h
#ifndef FLATCC_RTCONFIG_H
#define FLATCC_RTCONFIG_H

#ifdef __cplusplus
extern "C" {
#endif


/* Include portability layer here since all other files depend on it. */
#ifdef FLATCC_PORTABLE
#define JDV_FLATCC_INCLUDE_flatcc_portable_portable_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_portable_h
#endif

/*
 * Fast printing and parsing of double.
 *
 * This requires the grisu3/grisu3_* files to be in the include path,
 * otherwise strod and sprintf will be used (these needed anyway
 * as fallback for cases not supported by grisu3).
 */
#ifndef FLATCC_USE_GRISU3
#define FLATCC_USE_GRISU3 1
#endif

/*
 * This requires compiler that has enabled marc=native or similar so
 * __SSE4_2__ flag is defined. Otherwise it will have no effect.
 *
 * While SSE may be used for different purposes, it has (as of this
 * writing) only be used to test the effect on JSON whitespace handling
 * which improved, but not by a lot, assuming 64-bit unligned access is
 * otherwise available:
 *
 * With 8 space indentation, the JSON benchmark handles 308K parse ops/sec
 * while SSE ups that to 333 parse ops/sec or 336 if \r\n is also
 * consumed by SSE. Disabling indentation leaves SSE spacing handling
 * ineffective, and performance reaches 450K parse ops/sec and can
 * improve further to 500+K parse ops/sec if inexact GRISU3 numbers are
 * allowed (they are pretty accurate anyway, just not exact). This
 * feature requires hacking a flag direct in the grisu3 double parsing
 * lib directly and only mentioned for comparison.
 *
 * In conclusion SSE doesn't add a lot to JSON space handling at least.
 *
 * Disabled by default, but can be overriden by build system.
 */
#ifndef FLATCC_USE_SSE4_2
#define FLATCC_USE_SSE4_2 0
#endif

/*
 * The verifier only reports yes and no. The following setting
 * enables assertions in debug builds. It must be compiled into
 * the runtime library and is not normally the desired behavior.
 *
 * NOTE: enabling this can break test cases so use with build, not test.
 */
#if !defined(FLATCC_DEBUG_VERIFY) && !defined(NDEBUG)
#define FLATCC_DEBUG_VERIFY 0
#endif

#if !defined(FLATCC_TRACE_VERIFY)
#define FLATCC_TRACE_VERIFY 0
#endif

/*
 * Some producers allow empty vectors to be misaligned.
 * The following setting will cause the verifier to require the index 0
 * position to be element aligned even if the vector is empty (otherwise that
 * position is only required to be aligned to the preceding size field).
 */
#if !defined(FLATCC_ENFORCE_ALIGNED_EMPTY_VECTORS)
#define FLATCC_ENFORCE_ALIGNED_EMPTY_VECTORS 0
#endif

/*
 * Limit recursion level for tables. Actual level may be deeper
 * when structs are deeply nested - but these are limited by the
 * schema compiler.
 */
#ifndef FLATCC_JSON_PRINT_MAX_LEVELS
#define FLATCC_JSON_PRINT_MAX_LEVELS 100
#endif

/* Maximum length of names printed exluding _type suffix. */
#ifndef FLATCC_JSON_PRINT_NAME_LEN_MAX
#define FLATCC_JSON_PRINT_NAME_LEN_MAX 100
#endif

/*
 * Print float and double values with C99 hexadecimal floating point
 * notation. This option is not valid JSON but it avoids precision
 * loss, correctly handles NaN, +/-Infinity and is significantly faster
 * to parse and print. Some JSON parsers rely on strtod which does
 * support hexadecimal floating points when C99 compliant.
 */
#ifndef FLATCC_JSON_PRINT_HEX_FLOAT
#define FLATCC_JSON_PRINT_HEX_FLOAT 0
#endif

/*
 * Always print multipe enum flags like `color: "Red Green"`
 * even when unquote is selected as an option for single
 * value like `color: Green`. Otherwise multiple values
 * are printed as `color: Red Green`, but this could break
 * some flatbuffer json parser.
 */
#ifndef FLATCC_JSON_PRINT_ALWAYS_QUOTE_MULTIPLE_FLAGS
#define FLATCC_JSON_PRINT_ALWAYS_QUOTE_MULTIPLE_FLAGS 1
#endif

/*
 * The general nesting limit may be lower, but for skipping
 * JSON we do not need to - we can set this high as it only
 * costs a single char per level in a stack array.
 */
#ifndef FLATCC_JSON_PARSE_GENERIC_MAX_NEST
#define FLATCC_JSON_PARSE_GENERIC_MAX_NEST 512
#endif

/* Store value even if it is default. */
#ifndef FLATCC_JSON_PARSE_FORCE_DEFAULTS
#define FLATCC_JSON_PARSE_FORCE_DEFAULTS 0
#endif

#ifndef FLATCC_JSON_PARSE_ALLOW_UNQUOTED
#define FLATCC_JSON_PARSE_ALLOW_UNQUOTED 1
#endif

/*
 * Multiple enum values are by default not permitted unless
 * quoted like `color: "Red Green" as per Googles flatc JSON
 * parser while a single value like `color: Red` can be
 * unquoted.  Enabling this setting will allow `color: Red
 * Green`, but only if FLATCC_JSON_PARSE_ALLOW_UNQUOTED is
 * also enabled.
 */
#ifndef FLATCC_JSON_PARSE_ALLOW_UNQUOTED_LIST
#define FLATCC_JSON_PARSE_ALLOW_UNQUOTED_LIST 0
#endif

#ifndef FLATCC_JSON_PARSE_ALLOW_UNKNOWN_FIELD
#define FLATCC_JSON_PARSE_ALLOW_UNKNOWN_FIELD 1
#endif

#ifndef FLATCC_JSON_PARSE_ALLOW_TRAILING_COMMA
#define FLATCC_JSON_PARSE_ALLOW_TRAILING_COMMA 1
#endif

/*
 * Just parse to the closing bracket '}' if set.
 * Otherwise parse to end by consuming space and
 * fail if anything but space follows.
 */
#ifndef FLATCC_PARSE_IGNORE_TRAILING_DATA
#define FLATCC_PARSE_IGNORE_TRAILING_DATA 0
#endif

/*
 * Optimize to parse a lot of white space, but
 * in most cases it probably slows parsing down.
 */
#ifndef FLATCC_JSON_PARSE_WIDE_SPACE
#define FLATCC_JSON_PARSE_WIDE_SPACE 0
#endif

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_RTCONFIG_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h
#ifndef FLATCC_TYPES_H
#define FLATCC_TYPES_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdlib.h>

#ifndef UINT8_MAX
#include <stdint.h>
#endif

/*
 * This should match generated type declaratios in
 * `flatbuffers_common_reader.h` (might have different name prefix).
 * Read only generated code does not depend on library code,
 * hence the duplication.
 */
#ifndef flatbuffers_types_defined
#define flatbuffers_types_defined

/*
 * uoffset_t and soffset_t must be same integer type, except for sign.
 * They can be (u)int16_t, (u)int32_t, or (u)int64_t.
 * The default is (u)int32_t.
 *
 * voffset_t is expected to be uint16_t, but can experimentally be
 * compiled from uint8_t up to uint32_t.
 *
 * ID_MAX is the largest value that can index a vtable. The table size
 * is given as voffset value. Each id represents a voffset value index
 * from 0 to max inclusive. Space is required for two header voffset
 * fields and the unaddressible highest index (due to the table size
 * representation). For 16-bit voffsets this yields a max of 2^15 - 4,
 * or (2^16 - 1) / 2 - 3.
 */

#define flatbuffers_uoffset_t_defined
#define flatbuffers_soffset_t_defined
#define flatbuffers_voffset_t_defined
#define flatbuffers_utype_t_defined
#define flatbuffers_bool_t_defined
#define flatbuffers_thash_t_defined
#define flatbuffers_fid_t_defined

/* uoffset_t is also used for vector and string headers. */
#define FLATBUFFERS_UOFFSET_MAX UINT32_MAX
#define FLATBUFFERS_SOFFSET_MAX INT32_MAX
#define FLATBUFFERS_SOFFSET_MIN INT32_MIN
#define FLATBUFFERS_VOFFSET_MAX UINT16_MAX
#define FLATBUFFERS_UTYPE_MAX UINT8_MAX
/* Well - the max of the underlying type. */
#define FLATBUFFERS_BOOL_MAX UINT8_MAX
#define FLATBUFFERS_THASH_MAX UINT32_MAX

#define FLATBUFFERS_ID_MAX (FLATBUFFERS_VOFFSET_MAX / sizeof(flatbuffers_voffset_t) - 3)
/* Vectors of empty structs can yield div by zero, so we must guard against this. */
#define FLATBUFFERS_COUNT_MAX(elem_size) (FLATBUFFERS_UOFFSET_MAX/((elem_size) == 0 ? 1 : (elem_size)))

#define FLATBUFFERS_UOFFSET_WIDTH 32
#define FLATBUFFERS_COUNT_WIDTH 32
#define FLATBUFFERS_SOFFSET_WIDTH 32
#define FLATBUFFERS_VOFFSET_WIDTH 16
#define FLATBUFFERS_UTYPE_WIDTH 8
#define FLATBUFFERS_BOOL_WIDTH 8
#define FLATBUFFERS_THASH_WIDTH 32

#define FLATBUFFERS_TRUE 1
#define FLATBUFFERS_FALSE 0

#define FLATBUFFERS_PROTOCOL_IS_LE 1
#define FLATBUFFERS_PROTOCOL_IS_BE 0

typedef uint32_t flatbuffers_uoffset_t;
typedef int32_t flatbuffers_soffset_t;
typedef uint16_t flatbuffers_voffset_t;
typedef uint8_t flatbuffers_utype_t;
typedef uint8_t flatbuffers_bool_t;
typedef uint32_t flatbuffers_thash_t;
/* Public facing type operations. */
typedef flatbuffers_utype_t flatbuffers_union_type_t;

// Unused const variables
// static const flatbuffers_bool_t flatbuffers_true = FLATBUFFERS_TRUE;
// static const flatbuffers_bool_t flatbuffers_false = FLATBUFFERS_FALSE;

#define FLATBUFFERS_IDENTIFIER_SIZE (FLATBUFFERS_THASH_WIDTH / 8)

typedef char flatbuffers_fid_t[FLATBUFFERS_IDENTIFIER_SIZE];

#endif /* flatbuffers_types_defined */

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_TYPES_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_flatcc_verifier_h)
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_verifier_h
#ifndef FLATCC_VERIFIER_H
#define FLATCC_VERIFIER_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Runtime support for verifying flatbuffers.
 *
 * Link with the verifier implementation file.
 *
 * Note:
 *
 * 1) nested buffers will NOT have their identifier verified.
 * The user may do so subsequently. The reason is in part because
 * the information is not readily avaible without generated reader code,
 * in part because the buffer might use a different, but valid,
 * identifier and the user has no chance of specifying this in the
 * verifier code. The root verifier also doesn't assume a specific id
 * but accepts a user supplied input which may be null.
 *
 * 2) All offsets in a buffer are verified for alignment relative to the
 * buffer start, but the buffer itself is only assumed to aligned to
 * uoffset_t. A reader should therefore ensure buffer alignment separately
 * before reading the buffer. Nested buffers are in fact checked for
 * alignment, but still only relative to the root buffer.
 *
 * 3) The max nesting level includes nested buffer nestings, so the
 * verifier might fail even if the individual buffers are otherwise ok.
 * This is to prevent abuse with lots of nested buffers.
 *
 *
 * IMPORTANT:
 *
 * Even if verifier passes, the buffer may be invalid to access due to
 * lack of alignemnt in memory, but the verifier is safe to call.
 *
 * NOTE: The buffer is not safe to modify after verification because an
 * attacker may craft overlapping data structures such that modification
 * of one field updates another in a way that violates the buffer
 * constraints. This may also be caused by a clever compression scheme.
 *
 * It is likely faster to rewrite the table although this is also
 * dangerous because an attacker (or even normal user) can draft a DAG
 * that explodes when expanded carelesslessly. A safer approach is to
 * hash all object references written and reuse those that match. This
 * will expand references into other objects while bounding expansion
 * and it will be safe to update assuming shared objects are ok to
 * update.
 *
 */
#define JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_flatcc_types_h

#define FLATCC_VERIFY_ERROR_MAP(XX)\
    XX(ok, "ok")\
    XX(buffer_header_too_small, "buffer header too small")\
    XX(identifier_mismatch, "identifier mismatch")\
    XX(max_nesting_level_reached, "max nesting level reached")\
    XX(required_field_missing, "required field missing")\
    XX(runtime_buffer_header_not_aligned, "runtime: buffer header not aligned")\
    XX(runtime_buffer_size_too_large, "runtime: buffer size too large")\
    XX(string_not_zero_terminated, "string not zero terminated")\
    XX(string_out_of_range, "string out of range")\
    XX(struct_out_of_range, "struct out of range")\
    XX(struct_size_overflow, "struct size overflow")\
    XX(struct_unaligned, "struct unaligned")\
    XX(table_field_not_aligned, "table field not aligned")\
    XX(table_field_out_of_range, "table field out of range")\
    XX(table_field_size_overflow, "table field size overflow")\
    XX(table_header_out_of_range_or_unaligned, "table header out of range or unaligned")\
    XX(vector_header_out_of_range_or_unaligned, "vector header out of range or unaligned")\
    XX(string_header_out_of_range_or_unaligned, "string header out of range or unaligned")\
    XX(offset_out_of_range, "offset out of range")\
    XX(table_offset_out_of_range_or_unaligned, "table offset out of range or unaligned")\
    XX(table_size_out_of_range, "table size out of range")\
    XX(type_field_absent_from_required_union_field, "type field absent from required union field")\
    XX(type_field_absent_from_required_union_vector_field, "type field absent from required union vector field")\
    XX(union_cannot_have_a_table_without_a_type, "union cannot have a table without a type")\
    XX(union_type_NONE_cannot_have_a_value, "union value field present with type NONE")\
    XX(vector_count_exceeds_representable_vector_size, "vector count exceeds representable vector size")\
    XX(vector_out_of_range, "vector out of range")\
    XX(vtable_header_out_of_range, "vtable header out of range")\
    XX(vtable_header_too_small, "vtable header too small")\
    XX(vtable_offset_out_of_range_or_unaligned, "vtable offset out of range or unaligned")\
    XX(vtable_size_out_of_range_or_unaligned, "vtable size out of range or unaligned")\
    XX(vtable_size_overflow, "vtable size overflow")\
    XX(union_element_absent_without_type_NONE, "union element absent without type NONE")\
    XX(union_element_present_with_type_NONE, "union element present with type NONE")\
    XX(union_vector_length_mismatch, "union type and table vectors have different lengths")\
    XX(union_vector_verification_not_supported, "union vector verification not supported")\
    XX(runtime_buffer_size_less_than_size_field, "runtime buffer size less than buffer headers size field")\
    XX(not_supported, "not supported")



enum flatcc_verify_error_no {
#define XX(no, str) flatcc_verify_error_##no,
    FLATCC_VERIFY_ERROR_MAP(XX)
#undef XX
};

#define flatcc_verify_ok flatcc_verify_error_ok

const char *flatcc_verify_error_string(int err);

/*
 * Type specific table verifier function that checks each known field
 * for existence in the vtable and then calls the appropriate verifier
 * function in this library.
 *
 * The table descriptor values have been verified for bounds, overflow,
 * and alignment, but vtable entries after header must be verified
 * for all fields the table verifier function understands.
 *
 * Calls other typespecific verifier functions recursively whenever a
 * table field, union or table vector is encountered.
 */
typedef struct flatcc_table_verifier_descriptor flatcc_table_verifier_descriptor_t;
struct flatcc_table_verifier_descriptor {
    /* Pointer to buffer. Not assumed to be aligned beyond uoffset_t. */
    const void *buf;
    /* Buffer size. */
    flatbuffers_uoffset_t end;
    /* Time to live: number nesting levels left before failure. */
    int ttl;
    /* Vtable of current table. */
    const void *vtable;
    /* Table offset relative to buffer start */
    flatbuffers_uoffset_t table;
    /* Table end relative to buffer start as per vtable[1] field. */
    flatbuffers_voffset_t tsize;
    /* Size of vtable in bytes. */
    flatbuffers_voffset_t vsize;
};

typedef int flatcc_table_verifier_f(flatcc_table_verifier_descriptor_t *td);

typedef struct flatcc_union_verifier_descriptor flatcc_union_verifier_descriptor_t;

struct flatcc_union_verifier_descriptor {
    /* Pointer to buffer. Not assumed to be aligned beyond uoffset_t. */
    const void *buf;
    /* Buffer size. */
    flatbuffers_uoffset_t end;
    /* Time to live: number nesting levels left before failure. */
    int ttl;
    /* Type of union value to be verified */
    flatbuffers_utype_t type;
    /* Offset relative to buffer start to where union value offset is stored. */
    flatbuffers_uoffset_t base;
    /* Offset of union value relative to base. */
    flatbuffers_uoffset_t offset;
};

typedef int flatcc_union_verifier_f(flatcc_union_verifier_descriptor_t *ud);

/*
 * The `as_root` functions are normally the only functions called
 * explicitly in this interface.
 *
 * If `fid` is null, the identifier is not checked and is allowed to be entirely absent.
 *
 * The buffer must at least be aligned to uoffset_t on systems that
 * require aligned memory addresses. The buffer pointers alignment is
 * not significant to internal verification of the buffer.
 *
 * The `_with_size` variant handles size prefixed buffers which aligns slighly differently
 * due to the size prefix, notably for buffers with alignment above the uoffset_t type.
 */
int flatcc_verify_struct_as_root(const void *buf, size_t bufsiz, const char *fid,
        size_t size, uint16_t align);

int flatcc_verify_struct_as_root_with_size(const void *buf, size_t bufsiz, const char *fid,
        size_t size, uint16_t align);

int flatcc_verify_struct_as_typed_root(const void *buf, size_t bufsiz, flatbuffers_thash_t thash,
        size_t size, uint16_t align);

int flatcc_verify_struct_as_typed_root_with_size(const void *buf, size_t bufsiz, flatbuffers_thash_t thash,
        size_t size, uint16_t align);

int flatcc_verify_table_as_root(const void *buf, size_t bufsiz, const char *fid,
        flatcc_table_verifier_f *root_tvf);

int flatcc_verify_table_as_root_with_size(const void *buf, size_t bufsiz, const char *fid,
        flatcc_table_verifier_f *root_tvf);

int flatcc_verify_table_as_typed_root(const void *buf, size_t bufsiz, flatbuffers_thash_t thash,
        flatcc_table_verifier_f *root_tvf);

int flatcc_verify_table_as_typed_root_with_size(const void *buf, size_t bufsiz, flatbuffers_thash_t thash,
        flatcc_table_verifier_f *root_tvf);

/*
 * The buffer header is verified by any of the `_as_root` verifiers, but
 * this function may be used as a quick sanity check.
 */
int flatcc_verify_buffer_header(const void *buf, size_t bufsiz, const char *fid);

int flatcc_verify_typed_buffer_header(const void *buf, size_t bufsiz, flatbuffers_thash_t type_hash);

/*
 * Verifies size prefixed buffer headers. The `bufsiz` argument is a pointer that will be updated
 * with the size stored in the buffer header iff it is no larger than the input argument, and
 * otherwise the verifer fails. The updated size field adds sizeof(flatbuffers_uoffset_t) to the size
 * to be compatible with bufsiz since the header size field does not include itself.
 */
int flatcc_verify_buffer_header_with_size(const void *buf, size_t *bufsiz, const char *fid);

int flatcc_verify_typed_buffer_header_with_size(const void *buf, size_t *bufsiz, flatbuffers_thash_t thash);

/*
 * The following functions are typically called by a generated table
 * verifier function.
 */

/* Scalar, enum or struct field. */
int flatcc_verify_field(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, size_t size, uint16_t align);
/* Vector of scalars, enums or structs. */
int flatcc_verify_vector_field(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required, size_t elem_size, uint16_t align, size_t max_count);
int flatcc_verify_string_field(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required);
int flatcc_verify_string_vector_field(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required);
int flatcc_verify_table_field(flatcc_table_verifier_descriptor_t *td,
    flatbuffers_voffset_t id, int required, flatcc_table_verifier_f tvf);
int flatcc_verify_table_vector_field(flatcc_table_verifier_descriptor_t *td,
    flatbuffers_voffset_t id, int required, flatcc_table_verifier_f tvf);
/* Table verifiers pass 0 as fid. */
int flatcc_verify_struct_as_nested_root(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required, const char *fid,
        size_t size, uint16_t align);
int flatcc_verify_table_as_nested_root(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required, const char *fid,
        uint16_t align, flatcc_table_verifier_f tvf);

/*
 * A NONE type will not accept a table being present, and a required
 * union will not accept a type field being absent, and an absent type
 * field will not accept a table field being present.
 *
 * If the above checks out and the type is not NONE, the uvf callback
 * is executed. It must test each known table type and silently accept
 * any unknown table type for forward compatibility. A union table
 * value is verified without the required flag because an absent table
 * encodes a typed NULL value while an absent type field encodes a
 * missing union which fails if required.
 */
int flatcc_verify_union_field(flatcc_table_verifier_descriptor_t *td,
        flatbuffers_voffset_t id, int required, flatcc_union_verifier_f uvf);

int flatcc_verify_union_vector_field(flatcc_table_verifier_descriptor_t *td,
    flatbuffers_voffset_t id, int required, flatcc_union_verifier_f uvf);

int flatcc_verify_union_table(flatcc_union_verifier_descriptor_t *ud, flatcc_table_verifier_f *tvf);
int flatcc_verify_union_struct(flatcc_union_verifier_descriptor_t *ud, size_t size, uint16_t align);
int flatcc_verify_union_string(flatcc_union_verifier_descriptor_t *ud);

#ifdef __cplusplus
}
#endif

#endif /* FLATCC_VERIFIER_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h
#ifndef PALIGNED_ALLOC_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * NOTE: MSVC in general has no aligned alloc function that is
 * compatible with free and it is not trivial to implement a version
 * which is. Therefore, to remain portable, end user code needs to
 * use `aligned_free` which is not part of C11 but defined in this header.
 *
 * glibc only provides aligned_alloc when _ISOC11_SOURCE is defined, but
 * MingW does not support aligned_alloc despite of this, it uses the
 * the _aligned_malloc as MSVC.
 *
 * The same issue is present on some Unix systems not providing
 * posix_memalign.
 *
 * Note that clang and gcc with -std=c11 or -std=c99 will not define
 * _POSIX_C_SOURCE and thus posix_memalign cannot be detected but
 * aligned_alloc is not necessarily available either. We assume
 * that clang always has posix_memalign although it is not strictly
 * correct. For gcc, use -std=gnu99 or -std=gnu11 or don't use -std in
 * order to enable posix_memalign, or live with the fallback until using
 * a system where glibc has a version that supports aligned_alloc.
 *
 * For C11 compliant compilers and compilers with posix_memalign,
 * it is valid to use free instead of aligned_free with the above
 * caveats.
 */

#include <stdlib.h>

/*
 * Define this to see which version is used so the fallback is not
 * enganged unnecessarily:
 *
 * #define PORTABLE_DEBUG_ALIGNED_ALLOC
 */

#if 0
#define PORTABLE_DEBUG_ALIGNED_ALLOC
#endif

#if !defined(PORTABLE_C11_ALIGNED_ALLOC)

/*
 * PORTABLE_C11_ALIGNED_ALLOC = 1
 * indicates that the system has builtin aligned_alloc
 * If it doesn't, the section after detection provides an implemention.
 */
#if defined (__MINGW32__)
/* MingW does not provide aligned_alloc despite defining _ISOC11_SOURCE */
#define PORTABLE_C11_ALIGNED_ALLOC 0
#elif defined (_ISOC11_SOURCE)
/* glibc aligned_alloc detection, but MingW is not truthful */
#define PORTABLE_C11_ALIGNED_ALLOC 1
#elif defined (__GLIBC__)
/* aligned_alloc is not available in glibc just because __STDC_VERSION__ >= 201112L. */
#define PORTABLE_C11_ALIGNED_ALLOC 0
#elif defined (__clang__)
#define PORTABLE_C11_ALIGNED_ALLOC 0
#elif defined (__APPLE__)
#define PORTABLE_C11_ALIGNED_ALLOC 0
#elif defined(__IBMC__)
#define PORTABLE_C11_ALIGNED_ALLOC 0
#elif (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L)
#define PORTABLE_C11_ALIGNED_ALLOC 1
#else
#define PORTABLE_C11_ALIGNED_ALLOC 0
#endif

#endif /* PORTABLE_C11_ALIGNED_ALLOC */

/* https://linux.die.net/man/3/posix_memalign */
#if !defined(PORTABLE_POSIX_MEMALIGN) && defined(_GNU_SOURCE)
#define PORTABLE_POSIX_MEMALIGN 1
#endif

/* https://forum.kde.org/viewtopic.php?p=66274 */
#if !defined(PORTABLE_POSIX_MEMALIGN) && defined(_XOPEN_SOURCE)
#if _XOPEN_SOURCE >= 600
#define PORTABLE_POSIX_MEMALIGN 1
#endif
#endif

#if !defined(PORTABLE_POSIX_MEMALIGN) && defined(_POSIX_C_SOURCE)
#if _POSIX_C_SOURCE >= 200112L
#define PORTABLE_POSIX_MEMALIGN 1
#endif
#endif

#if !defined(PORTABLE_POSIX_MEMALIGN) && defined(__clang__)
#define PORTABLE_POSIX_MEMALIGN 1
#endif

#if !defined(PORTABLE_POSIX_MEMALIGN)
#define PORTABLE_POSIX_MEMALIGN 0
#endif

/* https://forum.kde.org/viewtopic.php?p=66274 */
#if (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L)
/* C11 or newer */
#include <stdalign.h>
#endif

/* C11 or newer */
#if !defined(aligned_alloc) && !defined(__aligned_alloc_is_defined)

#if PORTABLE_C11_ALIGNED_ALLOC
#ifdef PORTABLE_DEBUG_ALIGNED_ALLOC
#error "DEBUG: C11_ALIGNED_ALLOC configured"
#endif
#elif defined(_MSC_VER) || defined(__MINGW32__)

#ifdef PORTABLE_DEBUG_ALIGNED_ALLOC
#error "DEBUG: Windows _aligned_malloc configured"
#endif

/* Aligned _aligned_malloc is not compatible with free. */
#define aligned_alloc(alignment, size) _aligned_malloc(size, alignment)
#define aligned_free(p) _aligned_free(p)
#define __aligned_alloc_is_defined 1
#define __aligned_free_is_defined 1

#elif PORTABLE_POSIX_MEMALIGN

#if defined(__GNUC__)
#if !defined(__GNUCC__)
extern int posix_memalign (void **, size_t, size_t);
#elif __GNUCC__ < 5
extern int posix_memalign (void **, size_t, size_t);
#endif
#endif

static inline void *__portable_aligned_alloc(size_t alignment, size_t size)
{
    int err;
    void *p = 0;

    if (alignment < sizeof(void *)) {
        alignment = sizeof(void *);
    }
    err = posix_memalign(&p, alignment, size);
    if (err && p) {
        free(p);
        p = 0;
    }
    return p;
}

#ifdef PORTABLE_DEBUG_ALIGNED_ALLOC
#error "DEBUG: POSIX_MEMALIGN configured"
#endif

#define aligned_alloc(alignment, size) __portable_aligned_alloc(alignment, size)
#define aligned_free(p) free(p)
#define __aligned_alloc_is_defined 1
#define __aligned_free_is_defined 1

#else

static inline void *__portable_aligned_alloc(size_t alignment, size_t size)
{
    char *raw;
    void *buf;
    size_t total_size = (size + alignment - 1 + sizeof(void *));

    if (alignment < sizeof(void *)) {
        alignment = sizeof(void *);
    }
    raw = (char *)(size_t)malloc(total_size);
    if (!raw) return 0;
    buf = raw + alignment - 1 + sizeof(void *);
    buf = (void *)(((size_t)buf) & ~(alignment - 1));
    ((void **)buf)[-1] = raw;
    return buf;
}

static inline void __portable_aligned_free(void *p)
{
    char *raw;

    if (p) {
        raw = (char*)((void **)p)[-1];
        free(raw);
    }
}

#define aligned_alloc(alignment, size) __portable_aligned_alloc(alignment, size)
#define aligned_free(p) __portable_aligned_free(p)
#define __aligned_alloc_is_defined 1
#define __aligned_free_is_defined 1

#ifdef PORTABLE_DEBUG_ALIGNED_ALLOC
#error "DEBUG: aligned_alloc malloc fallback configured"
#endif

#endif

#endif /* aligned_alloc */

#if !defined(aligned_free) && !defined(__aligned_free_is_defined)
#define aligned_free(p) free(p)
#define __aligned_free_is_defined 1
#endif

#ifdef __cplusplus
}
#endif

#endif /* PALIGNED_ALLOC_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pattributes_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pattributes_h

/*
 * C23 introduces an attribute syntax `[[<attribute>]]`. Prior to that
 * other non-standard syntaxes such as `__attribute__((<attribute>))`
 * and `__declspec(<attribute>)` have been supported by some compiler
 * versions.
 *
 * See also:
 * https://en.cppreference.com/w/c/language/attributes
 *
 * There is no portable way to use C23 attributes in older C standards
 * so in order to use these portably, some macro name needs to be
 * defined for each attribute that either maps to the older supported
 * syntax, or ignores the attribute as appropriate.
 *
 * The Linux kernel defines certain attributes as macros, such as
 * `fallthrough`. When adding attributes it seems reasonable to follow
 * the Linux conventions in lack of any official standard. However, it
 * is not the intention that this file should mirror the Linux
 * attributes 1 to 1.
 *
 * See also:
 * https://github.com/torvalds/linux/blob/master/include/linux/compiler_attributes.h
 *
 * There is a risk that exposed attribute names may lead to name
 * conflicts. A conflicting name can be undefined and if necessary used
 * using `pattribute(<attribute>)`. All attributes can be hidden by
 * defining `PORTABLE_EXPOSE_ATTRIBUTES=0` in which case
 * `pattribute(<attribute>)` can still be used and then if a specific
 * attribute name still needs to be exposed, it can be defined manually
 * like `#define fallthrough pattribute(fallthrough)`.
 */


#ifndef PATTRIBUTES_H
#define PATTRIBUTES_H

#ifdef __cplusplus
extern "C" {
#endif

#ifndef PORTABLE_EXPOSE_ATTRIBUTES
#define PORTABLE_EXPOSE_ATTRIBUTES 0
#endif

#ifdef __has_c_attribute
# define PORTABLE_HAS_C_ATTRIBUTE(x) __has_c_attribute(x)
#else
# define PORTABLE_HAS_C_ATTRIBUTE(x) 0
#endif

#ifdef __has_attribute
# define PORTABLE_HAS_ATTRIBUTE(x) __has_attribute(x)
#else
# define PORTABLE_HAS_ATTRIBUTE(x) 0
#endif


/* https://en.cppreference.com/w/c/language/attributes/fallthrough */
#if PORTABLE_HAS_C_ATTRIBUTE(__fallthrough__) && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L
# define pattribute_fallthrough [[__fallthrough__]]
#elif PORTABLE_HAS_ATTRIBUTE(__fallthrough__)
# define pattribute_fallthrough __attribute__((__fallthrough__))
#else
# define pattribute_fallthrough ((void)0)
#endif


#define pattribute(x) pattribute_##x

#if PORTABLE_EXPOSE_ATTRIBUTES

#ifndef fallthrough
# define fallthrough pattribute(fallthrough)
#endif

#endif


#ifdef __cplusplus
}
#endif

#endif /* PATTRIBUTES_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_h
 /* There is intentionally no include guard in this file. */


/*
 * Usage: optionally disable any of these before including.
 *
 * #define PDIAGNOSTIC_IGNORE_UNUSED_FUNCTION
 * #define PDIAGNOSTIC_IGNORE_UNUSED_VARIABLE
 * #define PDIAGNOSTIC_IGNORE_UNUSED_PARAMETER
 * #define PDIAGNOSTIC_IGNORE_UNUSED // all of the above
 *
 * #include "pdiagnostic.h"
 *
 * Alternatively use #include "pdiagnostic_push/pop.h"
 */

#ifdef _MSC_VER
#pragma warning(disable: 4668) /* preprocessor name not defined */
#endif

#if !defined(PDIAGNOSTIC_AWARE_MSVC) && defined(_MSC_VER)
#define PDIAGNOSTIC_AWARE_MSVC 1
#elif !defined(PDIAGNOSTIC_AWARE_MSVC)
#define PDIAGNOSTIC_AWARE_MSVC 0
#endif

#if !defined(PDIAGNOSTIC_AWARE_CLANG) && defined(__clang__)
#define PDIAGNOSTIC_AWARE_CLANG 1
#elif !defined(PDIAGNOSTIC_AWARE_CLANG)
#define PDIAGNOSTIC_AWARE_CLANG 0
#endif

#if !defined(PDIAGNOSTIC_AWARE_GCC) && defined(__GNUC__) && !defined(__clang__)
/* Can disable some warnings even if push is not available (gcc-4.2 vs gcc-4.7) */
#if (__GNUC__ > 4) || (__GNUC__ == 4 && __GNUC_MINOR__ >= 2)
#define PDIAGNOSTIC_AWARE_GCC 1
#endif
#endif

#if !defined(PDIAGNOSTIC_AWARE_GCC)
#define PDIAGNOSTIC_AWARE_GCC 0
#endif

#if defined(PDIAGNOSTIC_IGNORE_UNUSED_FUNCTION) || defined(PDIAGNOSTIC_IGNORE_UNUSED)
#if PDIAGNOSTIC_AWARE_CLANG
#pragma clang diagnostic ignored "-Wunused-function"
#elif PDIAGNOSTIC_AWARE_GCC
#pragma GCC diagnostic ignored "-Wunused-function"
#endif
#endif
#undef PDIAGNOSTIC_IGNORE_UNUSED_FUNCTION

#if defined(PDIAGNOSTIC_IGNORE_UNUSED_VARIABLE) || defined(PDIAGNOSTIC_IGNORE_UNUSED)
#if PDIAGNOSTIC_AWARE_MSVC
#pragma warning(disable: 4101) /* unused local variable */
#elif PDIAGNOSTIC_AWARE_CLANG
#pragma clang diagnostic ignored "-Wunused-variable"
#elif PDIAGNOSTIC_AWARE_GCC
#pragma GCC diagnostic ignored "-Wunused-variable"
#endif
#endif
#undef PDIAGNOSTIC_IGNORE_UNUSED_VARIABLE

#if defined(PDIAGNOSTIC_IGNORE_UNUSED_PARAMETER) || defined(PDIAGNOSTIC_IGNORE_UNUSED)
#if PDIAGNOSTIC_AWARE_CLANG
#pragma clang diagnostic ignored "-Wunused-parameter"
#elif PDIAGNOSTIC_AWARE_GCC
#pragma GCC diagnostic ignored "-Wunused-parameter"
#endif
#endif
#undef PDIAGNOSTIC_IGNORE_UNUSED_PARAMETER

#undef PDIAGNOSTIC_IGNORE_UNUSED

#if defined (__cplusplus) && __cplusplus < 201103L
#if PDIAGNOSTIC_AWARE_CLANG
/* Needed for < C++11 clang C++ static_assert */
#pragma clang diagnostic ignored "-Wc11-extensions"
/* Needed for empty macro arguments. */
#pragma clang diagnostic ignored "-Wc99-extensions"
/* Needed for trailing commas. */
#pragma clang diagnostic ignored "-Wc++11-extensions"
#endif
#endif
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_pop_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_pop_h
#if defined(PDIAGNOSTIC_PUSHED_MSVC)
#if PDIAGNOSTIC_PUSHED_MSVC
#pragma warning( pop )
#endif // PDIAGNOSTIC_PUSHED_MSVC
#undef PDIAGNOSTIC_PUSHED_MSVC
#endif // defined(PDIAGNOSTIC_PUSHED_MSVC)

#if defined(PDIAGNOSTIC_PUSHED_CLANG)
#if PDIAGNOSTIC_PUSHED_CLANG
#pragma clang diagnostic pop
#endif // PDIAGNOSTIC_PUSHED_CLANG
#undef PDIAGNOSTIC_PUSHED_CLANG
#endif // defined(PDIAGNOSTIC_PUSHED_CLANG)

#if defined(PDIAGNOSTIC_PUSHED_GCC)
#if PDIAGNOSTIC_PUSHED_GCC
#pragma GCC diagnostic pop
#endif // PDIAGNOSTIC_PUSHED_GCC
#undef PDIAGNOSTIC_PUSHED_GCC
#endif // defined(PDIAGNOSTIC_PUSHED_GCC)
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_push_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_push_h
/*
 * See also comment in "pdiagnostic.h"
 *
 * e.g.
 * #define PDIAGNOSTIC_IGNORE_USED_FUNCTION
 * #define PDIAGNOSTIC_IGNORE_USED_VARIABLE
 * #include "pdiagnostic_push"
 * ...
 * #include "pdiagnostic_pop.h"
 * <eof>
 *
 * or if push pop isn't desired:
 * #define PDIAGNOSTIC_IGNORE_USED_FUNCTION
 * #define PDIAGNOSTIC_IGNORE_USED_VARIABLE
 * #include "pdiagnostic.h"
 * ...
 * <eof>
 *
 *
 * Some if these warnings cannot be ignored
 * at the #pragma level, but might in the future.
 * Use compiler switches like -Wno-unused-function
 * to work around this.
 */

#if defined(_MSC_VER)
#pragma warning( push )
#define PDIAGNOSTIC_PUSHED_MSVC 1
#else
#define PDIAGNOSTIC_PUSHED_MSVC 0
#endif

#if defined(__clang__)
#pragma clang diagnostic push
#define PDIAGNOSTIC_PUSHED_CLANG 1
#else
#define PDIAGNOSTIC_PUSHED_CLANG 0
#endif

#if defined(__GNUC__) && !defined(__clang__)
#if ((__GNUC__ > 4) || (__GNUC__ == 4 && __GNUC_MINOR__ >= 6))
#pragma GCC diagnostic push
#define PDIAGNOSTIC_PUSHED_GCC 1
#else
#define PDIAGNOSTIC_PUSHED_GCC 0
#endif // GNUC >= 4.6
#else
#define PDIAGNOSTIC_PUSHED_GCC 0
#endif // defined(__GNUC__) && !defined(__clang__)
#define JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pdiagnostic_h
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h
#ifndef PENDIAN_H
#define PENDIAN_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Defines platform optimized (as per linux <endian.h>
 *
 *     le16toh, le32to, le64toh, be16toh, be32toh, be64toh
 *     htole16, htole32, htole64, htobe16, htobe32, htobe64
 *
 * Falls back to auto-detect endian conversion which is also fast
 * if fast byteswap operation was detected.
 *
 * Also defines platform optimized:
 *
 *     bswap16, bswap32, bswap64,
 *
 * with fall-back to shift-or implementation.
 *
 * For convenience also defines:
 *
 *     le8to, be8toh, htole8, htobe8
 *     bswap8
 *
 * The convience functions makes is simpler to define conversion macros
 * based on type size.
 *
 * NOTE: this implementation expects arguments with no side-effects and
 * with appropriately sized unsigned arguments. These are expected to be
 * used with typesafe wrappers.
 */

#ifndef UINT8_MAX
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h
#endif

#if defined(__linux__)
#include <endian.h>
#elif defined(__OpenBSD__) || defined(__FreeBSD__)
#include <sys/endian.h>
#endif
#define JDV_FLATCC_INCLUDE_flatcc_portable_pendian_detect_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_detect_h

#if defined(_MSC_VER)
#if _MSC_VER >= 1300
#include <stdlib.h>
#define bswap16 _byteswap_ushort
#define bswap32 _byteswap_ulong
#define bswap64 _byteswap_uint64
#endif
#elif defined(__clang__)
#if __has_builtin(__builtin_bswap16)
#ifndef bswap16
#define bswap16 __builtin_bswap16
#endif
#endif
#if __has_builtin(__builtin_bswap32)
#ifndef bswap32
#define bswap32 __builtin_bswap32
#endif
#endif
#if __has_builtin(__builtin_bswap64)
#ifndef bswap64
#define bswap64 __builtin_bswap64
#endif
#endif
#elif defined(__OpenBSD__) || defined(__FreeBSD__)
#ifndef bswap16
#define bswap16 swap16
#endif
#ifndef bswap32
#define bswap32 swap32
#endif
#ifndef bswap64
#define bswap64 swap64
#endif
#elif defined(__GNUC__)  /* Supported since at least GCC 4.4 */
#ifndef bswap32
#define bswap32 __builtin_bswap32
#endif
#ifndef bswap64
#define bswap64 __builtin_bswap64
#endif
#endif

#ifndef bswap16
#define bswap16(v)                                                          \
      (((uint16_t)(v) << 8) | ((uint16_t)(v) >> 8))
#endif

#ifndef bswap32
#define bswap32(v)                                                          \
      ((((uint32_t)(v) << 24))                                              \
          | (((uint32_t)(v) << 8) & UINT32_C(0x00FF0000))                   \
          | (((uint32_t)(v) >> 8) & UINT32_C(0x0000FF00))                   \
          | (((uint32_t)(v) >> 24)))
#endif

#ifndef bswap64
#define bswap64(v)                                                          \
      ((((uint64_t)(v) << 56))                                              \
          | (((uint64_t)(v) << 40) & UINT64_C(0x00FF000000000000))          \
          | (((uint64_t)(v) << 24) & UINT64_C(0x0000FF0000000000))          \
          | (((uint64_t)(v) << 8) & UINT64_C(0x000000FF00000000))           \
          | (((uint64_t)(v) >> 8) & UINT64_C(0x00000000FF000000))           \
          | (((uint64_t)(v) >> 24) & UINT64_C(0x0000000000FF0000))          \
          | (((uint64_t)(v) >> 40) & UINT64_C(0x000000000000FF00))          \
          | (((uint64_t)(v) >> 56)))
#endif

#ifndef bswap8
#define bswap8(v) ((uint8_t)(v))
#endif

#if !defined(le16toh) && defined(letoh16)
#define le16toh letoh16
#define le32toh letoh32
#define le64toh letoh64
#endif

#if !defined(be16toh) && defined(betoh16)
#define be16toh betoh16
#define be32toh betoh32
#define be64toh betoh64
#endif

/* Assume it goes for all. */
#if !defined(le16toh)

#if defined(__LITTLE_ENDIAN__)

#define le16toh(v) (v)
#define le32toh(v) (v)
#define le64toh(v) (v)

#define htole16(v) (v)
#define htole32(v) (v)
#define htole64(v) (v)

#define be16toh(v) bswap16(v)
#define be32toh(v) bswap32(v)
#define be64toh(v) bswap64(v)

#define htobe16(v) bswap16(v)
#define htobe32(v) bswap32(v)
#define htobe64(v) bswap64(v)

#elif defined(__BIG_ENDIAN__)

#define le16toh(v) bswap16(v)
#define le32toh(v) bswap32(v)
#define le64toh(v) bswap64(v)

#define htole16(v) bswap16(v)
#define htole32(v) bswap32(v)
#define htole64(v) bswap64(v)

#define be16toh(v) (v)
#define be32toh(v) (v)
#define be64toh(v) (v)

#define htobe16(v) (v)
#define htobe32(v) (v)
#define htobe64(v) (v)

#else

static const int __pendian_test = 1;

#define le16toh(v) (*(char *)&__pendian_test ? (v) : bswap16(v))
#define le32toh(v) (*(char *)&__pendian_test ? (v) : bswap32(v))
#define le64toh(v) (*(char *)&__pendian_test ? (v) : bswap64(v))

#define htole16(v) (*(char *)&__pendian_test ? (v) : bswap16(v))
#define htole32(v) (*(char *)&__pendian_test ? (v) : bswap32(v))
#define htole64(v) (*(char *)&__pendian_test ? (v) : bswap64(v))

#define be16toh(v) (*(char *)&__pendian_test ? bswap16(v) : (v))
#define be32toh(v) (*(char *)&__pendian_test ? bswap32(v) : (v))
#define be64toh(v) (*(char *)&__pendian_test ? bswap64(v) : (v))

#define htobe16(v) (*(char *)&__pendian_test ? bswap16(v) : (v))
#define htobe32(v) (*(char *)&__pendian_test ? bswap32(v) : (v))
#define htobe64(v) (*(char *)&__pendian_test ? bswap64(v) : (v))

#endif

#endif /* le16toh */

/* Helpers not part of Linux <endian.h> */
#if !defined(le8toh)
#define le8toh(n) (n)
#define htole8(n) (n)
#define be8toh(n) (n)
#define htobe8(n) (n)
#endif

#ifdef __cplusplus
}
#endif

#endif /* PENDIAN_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pendian_detect_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_detect_h
/*
 * Uses various known flags to decide endianness and defines:
 *
 * __LITTLE_ENDIAN__ or __BIG_ENDIAN__ if not already defined
 *
 * and also defines
 *
 * __BYTE_ORDER__ to either __ORDER_LITTLE_ENDIAN__ or
 * __ORDER_BIG_ENDIAN__ if not already defined
 *
 * If none of these could be set, __UNKNOWN_ENDIAN__ is defined,
 * which is not a known flag. If __BYTE_ORDER__ is defined but
 * not big or little endian, __UNKNOWN_ENDIAN__ is also defined.
 *
 * Note: Some systems define __BYTE_ORDER without __ at the end
 * - this will be mapped to to __BYTE_ORDER__.
 */

#ifndef PENDIAN_DETECT
#define PENDIAN_DETECT

#ifdef __cplusplus
extern "C" {
#endif

#ifndef __ORDER_LITTLE_ENDIAN__
#define __ORDER_LITTLE_ENDIAN__ 1234
#endif

#ifndef __ORDER_BIG_ENDIAN__
#define __ORDER_BIG_ENDIAN__ 4321
#endif

#ifdef __BYTE_ORDER__

#if defined(__LITTLE_ENDIAN__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error __LITTLE_ENDIAN__ inconsistent with __BYTE_ORDER__
#endif

#if defined(__BIG_ENDIAN__) && __BYTE_ORDER__ != __ORDER_BIG_ENDIAN__
#error __BIG_ENDIAN__ inconsistent with __BYTE_ORDER__
#endif

#else /* __BYTE_ORDER__ */


#if                                                                         \
  defined(__LITTLE_ENDIAN__) ||                                             \
  (defined(__BYTE_ORDER) && __BYTE_ORDER == __ORDER_LITTLE_ENDIAN) ||       \
  defined(__ARMEL__) || defined(__THUMBEL__) ||                             \
  defined(__AARCH64EL__) ||                                                 \
  (defined(_MSC_VER) && defined(_M_ARM)) ||                                 \
  defined(_MIPSEL) || defined(__MIPSEL) || defined(__MIPSEL__) ||           \
  defined(_M_X64) || defined(_M_IX86) || defined(_M_I86) ||                 \
  defined(__i386__) || defined(__alpha__) ||                                \
  defined(__ia64) || defined(__ia64__) ||                                   \
  defined(_M_IA64) || defined(_M_ALPHA) ||                                  \
  defined(__amd64) || defined(__amd64__) || defined(_M_AMD64) ||            \
  defined(__x86_64) || defined(__x86_64__) || defined(_M_X64) ||            \
  defined(__bfin__)

#define __BYTE_ORDER__ __ORDER_LITTLE_ENDIAN__

#endif

#if                                                                         \
  defined (__BIG_ENDIAN__) ||                                               \
  (defined(__BYTE_ORDER) && __BYTE_ORDER == __ORDER_BIG_ENDIAN) ||          \
  defined(__ARMEB__) || defined(THUMBEB__) || defined (__AARCH64EB__) ||    \
  defined(_MIPSEB) || defined(__MIPSEB) || defined(__MIPSEB__) ||           \
  defined(__sparc) || defined(__sparc__) ||                                 \
  defined(_POWER) || defined(__powerpc__) || defined(__ppc__) ||            \
  defined(__hpux) || defined(__hppa) || defined(__s390__)

#define __BYTE_ORDER__ __ORDER_BIG_ENDIAN__

#endif

#endif /* __BYTE_ORDER__ */

#ifdef __BYTE_ORDER__

#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__

#ifndef __LITTLE_ENDIAN__
#define __LITTLE_ENDIAN__ 1
#endif

#elif __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__

#ifndef __BIG_ENDIAN__
#define __BIG_ENDIAN__ 1
#endif

#else

/*
 * Custom extension - we only define __BYTE_ORDER__ if known big or little.
 * User code that understands __BYTE_ORDER__ may also assume unkown if
 * it is not defined by now - this will allow other endian formats than
 * big or little when supported by compiler.
 */
#ifndef __UNKNOWN_ENDIAN__
#define __UNKNOWN_ENDIAN__ 1
#endif

#endif
#endif /* __BYTE_ORDER__ */

#if defined(__LITTLE_ENDIAN__) && defined(__BIG_ENDIAN__)
#error conflicting definitions of __LITTLE_ENDIAN__ and __BIG_ENDIAN__
#endif

#ifdef __cplusplus
}
#endif

#endif /* PENDIAN_DETECT */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h
#ifndef PINLINE_H
#define PINLINE_H

#ifndef __cplusplus

#if (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L)
/* C99 or newer */
#elif _MSC_VER >= 1500 /* MSVC 9 or newer */
#undef inline
#define inline __inline
#elif __GNUC__ >= 3 /* GCC 3 or newer */
#define inline __inline
#else /* Unknown or ancient */
#define inline
#endif

#endif /* __cplusplus */

#endif /* PINLINE_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pinttypes_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pinttypes_h
#ifndef PINTTYPES_H
#define PINTTYPES_H

#ifndef PRId16

#if (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L)
/* C99 or newer */
#include <inttypes.h>
#else

/*
 * This is not a complete implementation of <inttypes.h>, just the most
 * useful printf modifiers.
 */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h

#ifndef PRINTF_INT64_MODIFIER
#error "please define PRINTF_INT64_MODIFIER"
#endif

#ifndef PRId64
#define PRId64 PRINTF_INT64_MODIFIER "d"
#define PRIu64 PRINTF_INT64_MODIFIER "u"
#define PRIx64 PRINTF_INT64_MODIFIER "x"
#endif

#ifndef PRINTF_INT32_MODIFIER
#define PRINTF_INT32_MODIFIER "l"
#endif

#ifndef PRId32
#define PRId32 PRINTF_INT32_MODIFIER "d"
#define PRIu32 PRINTF_INT32_MODIFIER "u"
#define PRIx32 PRINTF_INT32_MODIFIER "x"
#endif

#ifndef PRINTF_INT16_MODIFIER
#define PRINTF_INT16_MODIFIER "h"
#endif

#ifndef PRId16
#define PRId16 PRINTF_INT16_MODIFIER "d"
#define PRIu16 PRINTF_INT16_MODIFIER "u"
#define PRIx16 PRINTF_INT16_MODIFIER "x"
#endif

# endif /* __STDC__ */

#endif /* PRId16 */

#endif /* PINTTYPES */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h
/*
 * Copyright (c) 2024 Mikkel Fahnøe Jørgensen, dvide.com
 *
 * (MIT License)
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

/* Provide strict aliasing safe portable access to reading and writing integer and
   floating point values from memory buffers of size 1, 2, 4, and 8 bytes, and
   optionally 16 bytes when C23 uint128_t is available.
   Also supports casting between integers and floats at the binary level, e.g.
   mem_read_float32(&myuint32), which can be necessary for endian conversions.

   It is often suggested to use memcpy for this purpose, that is not an ideal
   solution. See comments below.

   While this is intended to be aligned access, the strict C aliasing rules forces
   this to be the same as unaligned access. On x86/64 we can be more relaxed both
   with aliasing and alignment, but if at some point a compiler starts to
   modify this behaviour, the header can be updated or PORTABLE_MEM_PTR_ACCESS
   can be defined to 0 in the build configuration, or this file can be updated.

   The balance is betweem knowing memcpy or __builtin_memcpy is fast,
   and knowing that pointer casts do not break.

   Known targets that require PORTABLE_MEM_PTR_ACCESS=0 for at least some version:

      - ARM cross compiler: arm-none-eabi, -O2, -mcpu=cortext-m7,
        breaks on PORTABLE_MEM_PTR_ACCESS=0
        slow memcpy, has fast __builtin_memcpy

      - Intel ICC -O3 on x86/64 (that compiler is deprecated by Intel).
        breaks on PORTABLE_MEM_PTR_ACCESS=0
        has __builtin_memcpy, performance unknown, memcpy perforamnce unknown.

 */


/* NOTE: for best performance, `__builtin_memcpy` should be detectable, but
   the current detection logic is not ideal for older compilers. See below. */


#ifndef PMEMACCESS_H
#define PMEMACCESS_H


#ifdef __cplusplus
extern "C" {
#endif


/* Set to 1 to see which implementation is chosen on current platform. */
#ifndef PORTABLE_MEM_ACCESS_DEBUG
#define PORTABLE_MEM_ACCESS_DEBUG 0
#endif

/* MEM_PTR_ACCESS (aka pointer casts) (*(T *)p) is not formally valid for strict aliasing.
   It works in most cases, but not always. It may be the best option for older
   compilers that do not optimize well and which don't care about strict aliazing.
   x86/64 platforms appears to work well with this, while it only sometimes work
   on other platforms.

   NOTE: this might change as compiler updates their optimization strategies. */

#ifndef PORTABLE_MEM_PTR_ACCESS

#if defined(__INTEL_COMPILER)
#  /* Prevents Intel ICC compiler from breaking on -O3 on x86/64 target,
      likely due to strict aliasing rules. */
#  define PORTABLE_MEM_PTR_ACCESS 0
#elif (defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64))
#  define PORTABLE_MEM_PTR_ACCESS 1
#else
#  define PORTABLE_MEM_PTR_ACCESS 0
#endif

#endif /* PORTABLE_MEM_PTR_ACCESS */


#ifndef UINT8_MAX
#  include <stdint.h>
#endif

/* `mem_copy_word` implements optimized non-overlapping memory copies of
   1, 2, 4, 8, or 16 bytes, noting that C23 introduces uin128_t.
   Other sizes are not defined even if some implementation might support them.
   `mem_copy_word` of 16 bytes are supported even if uint128_t is not available.

   Ideally call `mem_copy_word` with known constant lengths for best optimization.

   The objective is both to support type punning where a binary representation is
   reinterpreted, and to read and write integers and floats safely from memory without
   risking undefined behaviour from strict aliasing rules.

   `memcpy` is supposed to handle this efficiently given small constant powers of 2, but
   this evidently fails on some platforms since even small constants lengths with -O2
   level optimization can issue a function call. On such platforms, `__builtin_memcpy`
   tends to work better, if it can be detected.

   A pointer cast can and will, albeit uncommon, lead to undefined behaviour
   such as reading from uninitialized stack memory when strict aliasing is the default
   optimization strategy.

   Note: __has_builtin is not necessarily defined on platforms with __builtin_memcpy support,
   so detection can be improved. Feel free to contribute.

   Note: `mem_copy_word_` is a macro that may call `mem_copy_word` but it is guaranteed to
   be called with a literal length argument, so it could be redefined to forward calls
   to e.g. my_mem_copy_word_2 via token pasting. It is used with the `mem_read/write_nn`
   functions below.  */

#ifndef mem_copy_word
#  if defined(__has_builtin)
#    if __has_builtin(__builtin_memcpy)
#      define mem_copy_word(d, s, n) __builtin_memcpy((d), (s), (n))
#      if PORTABLE_MEM_ACCESS_DEBUG
#        error mem_copy_word using: __builtin_memcpy
#      endif
#    endif
#  endif
#endif

#ifndef mem_copy_word
#define JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_prestrict_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_prestrict_h
    /* Sometimes `memcpy` is a call even when optimized and given small constant length arguments,
       so this is more likely to be optimized. `int len` is used to avoid <stddef.h> dependency.
       Also, by not using `memcpy`, we avoid depending on <stdlib.h>.

      As an alternative consider PORTABLE_MEM_PTR_ACCESS=1 with `mem_read/write_nn` for some older
      platforms that might not care about strict aliasing, and which also might not optimize well. */
    static inline void mem_copy_word(void * restrict dest, const void * restrict src, int len)
    {
        char *d = (char *)dest;
        const char *s = (const char *)src;
        while(len--) *d++ = *s++;
    }
    #if PORTABLE_MEM_ACCESS_DEBUG
    #  error mem_copy_word using: inline memcpy
    #endif
#endif


#if PORTABLE_MEM_PTR_ACCESS

#define mem_read_8(p)  (*(uint8_t*)(p))
#define mem_read_16(p) (*(uint16_t*)(p))
#define mem_read_32(p) (*(uint32_t*)(p))
#define mem_read_64(p) (*(uint64_t*)(p))

#define mem_write_8(p, v)  ((void)(*(uint8_t*)(p) = (uint8_t)(v)))
#define mem_write_16(p, v) ((void)(*(uint16_t*)(p) = (uint16_t)(v)))
#define mem_write_32(p, v) ((void)(*(uint32_t*)(p) = (uint32_t)(v)))
#define mem_write_64(p, v) ((void)(*(uint64_t*)(p) = (uint64_t)(v)))

#define mem_read_float_32(p) (*(float*)(p))
#define mem_read_float_64(p) (*(double*)(p))

#define mem_write_float_32(p, v) ((void)(*(float*)(p) = (float)(v)))
#define mem_write_float_64(p, v) ((void)(*(double*)(p) = (double)(v)))

#ifdef UINT128_MAX

#define mem_read_128(p) (*(uint128_t*)(p))

#define mem_write_128(p, v) ((void)(*(uint128_t*)(p) = (uint128_t)(v)))

#endif

#if PORTABLE_MEM_ACCESS_DEBUG
#  error mem_read/write_nn using: pointer cast
#endif

#else /* PORTABLE_MEM_PTR_ACCESS */

/* mem_copy_word_ is guaranteed to receive literal `n` arguments
   so operations can be optimized via token pasting if necessary. */
#ifndef mem_copy_word_
#define mem_copy_word_(d, s, n) mem_copy_word(d, s, n)
#endif

#define mem_read_8(p)  (*(uint8_t*)(p))
#define mem_write_8(p, v)  ((void)(*(uint8_t*)(p) = (uint8_t)(v)))

static inline uint16_t mem_read_16(const void *p) { uint16_t v; mem_copy_word_(&v, p, 2); return v; }
static inline uint32_t mem_read_32(const void *p) { uint32_t v; mem_copy_word_(&v, p, 4); return v; }
static inline uint64_t mem_read_64(const void *p) { uint64_t v; mem_copy_word_(&v, p, 8); return v; }

#define mem_write_16(p, v) do { const uint16_t x = (uint16_t)(v); mem_copy_word_((p), &x, 2); } while(0)
#define mem_write_32(p, v) do { const uint32_t x = (uint32_t)(v); mem_copy_word_((p), &x, 4); } while(0)
#define mem_write_64(p, v) do { const uint64_t x = (uint64_t)(v); mem_copy_word_((p), &x, 8); } while(0)

static inline float mem_read_float_32(const void *p) { float v; mem_copy_word_(&v, p, 4); return v; }
static inline double mem_read_float_64(const void *p) { double v; mem_copy_word_(&v, p, 8); return v; }

#define mem_write_float_32(p, v) do { const float x = (float)(v); mem_copy_word_((p), &x, 4); } while(0)
#define mem_write_float_64(p, v) do { const double x = (double)(v); mem_copy_word_((p), &x, 8); } while(0)

#ifdef UINT128_MAX

static inline uint128_t mem_read_128(const void *p) { uint128_t v; mem_copy_word_(&v, p, 16); return v; }

#define mem_write_128(p, v) do { const uint128_t x = (uint128_t)(v); mem_copy_word_((p), &x, 128); } while(0)

#endif

#if PORTABLE_MEM_ACCESS_DEBUG
#  error mem_read/write_nn using: mem_copy_word
#endif

#endif /* PORTABLE_MEM_PTR_ACCESS */


#ifdef __cplusplus
}
#endif

#endif /* PMEMACCESS_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_portable_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_portable_h
/* portable.h is widely used, so we redirect to a less conflicting name. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_portable_basic_h
#ifndef PORTABLE_BASIC_H
#define PORTABLE_BASIC_H

/*
 * Basic features need to make compilers support the most common moden C
 * features, and endian / unligned read support as well.
 *
 * It is not assumed that this file is always included.
 * Other include files are independent or include what they need.
 */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pversion_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pversion_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h

/* Featutures that ought to be supported by C11, but some aren't. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pinttypes_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pinttypes_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pinline_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h

/* These are not supported by C11 and are general platform abstractions. */
#define JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_punaligned_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_punaligned_h
#define JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pmemaccess_h


#endif /* PORTABLE_BASIC_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_prestrict_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_prestrict_h

/*
 * Copyright (c) 2024 Mikkel Fahnøe Jørgensen, dvide.com
 *
 * (MIT License)
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

#ifndef PRESTRICT_H
#define PRESTRICT_H


#if (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L)
/* C99 or newer */
#elif defined(__restrict)
/* Some C/C++ compilers use alternative syntax. If these are defines, we can detect them. */
#define restrict __restrict
#elif defined(__restrict__)
#define restrict __restrict__
#else
#define restrict
#endif


#endif /* PRESTRICT_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstatic_assert_h
#ifndef PSTATIC_ASSERT_H
#define PSTATIC_ASSERT_H

#include <assert.h>

/* Handle clang */
#ifndef __has_feature
  #define __has_feature(x) 0
#endif

#if defined(static_assert)
#ifndef __static_assert_is_defined
#define __static_assert_is_defined 1
#endif
#endif

/* Handle static_assert as a keyword in C++ and compiler specifics. */
#if !defined(__static_assert_is_defined)

#if defined(__cplusplus)

#if __cplusplus >= 201103L
#define __static_assert_is_defined 1
#elif __has_feature(cxx_static_assert)
#define __static_assert_is_defined 1
#elif defined(_MSC_VER) && (_MSC_VER >= 1600)
#define __static_assert_is_defined 1
#endif

#else

#if defined(_MSC_VER) && (_MSC_VER >= 1600)
#define __static_assert_is_defined 1
#elif __has_feature(c_static_assert)
#define static_assert(pred, msg) _Static_assert(pred, msg)
#define __static_assert_is_defined 1
#elif defined (__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
/* In case the clib headers are not compliant. */
#define static_assert(pred, msg) _Static_assert(pred, msg)
#define __static_assert_is_defined 1
#endif

#endif /* __cplusplus */
#endif /* __static_assert_is_defined */


#if !defined(__static_assert_is_defined)

#define __PSTATIC_ASSERT_CONCAT_(a, b) static_assert_scope_##a##_line_##b
#define __PSTATIC_ASSERT_CONCAT(a, b) __PSTATIC_ASSERT_CONCAT_(a, b)
#ifdef __COUNTER__
#define static_assert(e, msg) enum { __PSTATIC_ASSERT_CONCAT(__COUNTER__, __LINE__) = 1/(!!(e)) }
#else
#include "pstatic_assert_scope.h"
#define static_assert(e, msg) enum { __PSTATIC_ASSERT_CONCAT(__PSTATIC_ASSERT_COUNTER, __LINE__) = 1/(int)(!!(e)) }
#endif

#define __static_assert_is_defined 1

#endif /* __static_assert_is_defined */

#endif /* PSTATIC_ASSERT_H */

/* Update scope counter outside of include guard. */
#ifdef __PSTATIC_ASSERT_COUNTER
#include "pstatic_assert_scope.h"
#endif
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdalign_h
#ifndef PSTDALIGN_H
#define PSTDALIGN_H

/*
 * NOTE: aligned_alloc is defined via paligned_alloc.h
 * and requires aligned_free to be fully portable although
 * free also works on C11 and platforms with posix_memalign.
 *
 * NOTE: C++11 defines alignas as a keyword but then also defines
 * __alignas_is_defined.
 *
 * C++14 does not define __alignas_is_defined, at least sometimes.
 *
 * GCC 8.3 reverts on this and makes C++11 behave the same as C++14
 * preventing a simple __cplusplus version check from working.
 *
 * Clang C++ without std=c++11 or std=c++14 does define alignas
 * but does so incorrectly wrt. C11 and C++11 semantics because
 * `alignas(4) float x;` is not recognized.
 * To fix such issues, either move to a std version, or
 * include a working stdalign.h for the given compiler before
 * this file.
 *
 * newlib defines _Alignas and _Alignof in sys/cdefs but rely on
 * gcc version for <stdaligh.h> which can lead to conflicts if
 * stdalign is not included.
 *
 * newlibs need for <stdalign.h> conflicts with broken C++ stdalign
 * but this can be fixed be using std=C++11 or newer.
 *
 * MSVC does not support <stdalign.h> at least up to MSVC 2015,
 * but does appear to support alignas and alignof keywords in
 * recent standard C++.
 *
 * TCC only supports alignas with a numeric argument like
 * `alignas(4)`, but not `alignas(float)`.
 *
 * If stdalign.h is supported but heuristics in this file are
 * insufficient to detect this, try including <stdaligh.h> manually
 * or define HAVE_STDALIGN_H.
 */

/* https://github.com/dvidelabs/flatcc/issues/130 */
#ifndef __alignas_is_defined
#if defined(__cplusplus)
#if __cplusplus == 201103 && !defined(__clang__) && ((__GNUC__ > 8) || (__GNUC__ == 8 && __GNUC_MINOR__ >= 3))
#define __alignas_is_defined 1
#define __alignof_is_defined 1
#include <stdalign.h>
#endif
#endif
#endif

/* Allow for alternative solution to be included first. */
#ifndef __alignas_is_defined

#ifdef __cplusplus
#if defined(PORTABLE_PATCH_CPLUSPLUS_STDALIGN)
#include <stdalign.h>
#undef alignas
#define alignas(t) __attribute__((__aligned__(t)))
#endif
#endif

#if !defined(PORTABLE_HAS_INCLUDE_STDALIGN)
#if defined(__has_include)
#if __has_include(<stdalign.h>)
#define PORTABLE_HAS_INCLUDE_STDALIGN 1
#else
#define PORTABLE_HAS_INCLUDE_STDALIGN 0
#endif
#endif
#endif

 /* https://lists.gnu.org/archive/html/bug-gnulib/2015-08/msg00003.html */
#if defined(__cplusplus)
#if !defined(_MSC_VER)
#include <stdalign.h>
#endif
#if __cplusplus > 201103
#define __alignas_is_defined 1
#define __alignof_is_defined 1
#endif
#elif PORTABLE_HAS_INCLUDE_STDALIGN
#include <stdalign.h>
#elif !defined(__clang__) && ((__GNUC__ > 4) || (__GNUC__ == 4 && __GNUC_MINOR__ >= 7))
#include <stdalign.h>
#elif defined(HAVE_STDALIGN_H)
#include <stdaligh.h>
#endif

#endif /* __alignas_is_defined */

#ifndef __alignas_is_defined

#ifdef __cplusplus
extern "C" {
#endif

#if (!defined(__clang__) && defined(__GNUC__) && \
        ((__GNUC__ < 4) || (__GNUC__ == 4 && __GNUC_MINOR__ < 7)))
#undef PORTABLE_C11_STDALIGN_MISSING
#define PORTABLE_C11_STDALIGN_MISSING
#endif

#if defined(__IBMC__)
#undef PORTABLE_C11_STDALIGN_MISSING
#define PORTABLE_C11_STDALIGN_MISSING
#endif

#if ((defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L) && \
    !defined(PORTABLE_C11_STDALIGN_MISSING))
/* C11 or newer */
#include <stdalign.h>
#else
#if defined(__GNUC__) || defined(__IBM_ALIGNOF__) || defined(__clang__)

#ifndef _Alignas
#define _Alignas(t) __attribute__((__aligned__(t)))
#endif

#ifndef _Alignof
#define _Alignof(t) __alignof__(t)
#endif

#elif defined(_MSC_VER)

#define _Alignas(t) __declspec (align(t))
#define _Alignof(t) __alignof(t)

#elif defined(__TINYC__)

/* Supports `_Alignas(integer-expression)`, but not `_Alignas(type)`. */
#define _Alignas(t) __attribute__(aligned(t))
#define _Alignof(t) __alignof__(t)

#else
#error please update pstdalign.h with support for current compiler and library
#endif

#endif /* __STDC__ */

// For C23, alignas/alignof are keywords and will warn (-Wkeyword-macro) when #defined here
// GH-801: 202000L is the value used by Apple clang-16 when compiling with -std=gnu2x (i.e.,
// the draft standard at the time), which reflects the GitHub Actions runner at the time of this
// writing.
#if !(defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202000L)

#ifndef alignas
#define alignas _Alignas
#endif

#ifndef alignof
#define alignof _Alignof
#endif

#endif

#define __alignas_is_defined 1
#define __alignof_is_defined 1

#ifdef __cplusplus
}
#endif

#endif /* __alignas__is_defined */
#define JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_paligned_alloc_h

#endif /* PSTDALIGN_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pstdint_h
/*  A portable stdint.h
 ****************************************************************************
 *  BSD License:
 ****************************************************************************
 *
 *  Copyright (c) 2005-2016 Paul Hsieh
 *  All rights reserved.
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions
 *  are met:
 *
 *  1. Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 *  2. Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 *  3. The name of the author may not be used to endorse or promote products
 *     derived from this software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
 *  IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 *  OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
 *  INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 *  DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 *  THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 *  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 *  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 ****************************************************************************
 *
 *  Version 0.1.15.2
 *
 *  The ANSI C standard committee, for the C99 standard, specified the
 *  inclusion of a new standard include file called stdint.h.  This is
 *  a very useful and long desired include file which contains several
 *  very precise definitions for integer scalar types that is
 *  critically important for making portable several classes of
 *  applications including cryptography, hashing, variable length
 *  integer libraries and so on.  But for most developers its likely
 *  useful just for programming sanity.
 *
 *  The problem is that some compiler vendors chose to ignore the C99
 *  standard and some older compilers have no opportunity to be updated.
 *  Because of this situation, simply including stdint.h in your code
 *  makes it unportable.
 *
 *  So that's what this file is all about.  Its an attempt to build a
 *  single universal include file that works on as many platforms as
 *  possible to deliver what stdint.h is supposed to.  Even compilers
 *  that already come with stdint.h can use this file instead without
 *  any loss of functionality.  A few things that should be noted about
 *  this file:
 *
 *    1) It is not guaranteed to be portable and/or present an identical
 *       interface on all platforms.  The extreme variability of the
 *       ANSI C standard makes this an impossibility right from the
 *       very get go. Its really only meant to be useful for the vast
 *       majority of platforms that possess the capability of
 *       implementing usefully and precisely defined, standard sized
 *       integer scalars.  Systems which are not intrinsically 2s
 *       complement may produce invalid constants.
 *
 *    2) There is an unavoidable use of non-reserved symbols.
 *
 *    3) Other standard include files are invoked.
 *
 *    4) This file may come in conflict with future platforms that do
 *       include stdint.h.  The hope is that one or the other can be
 *       used with no real difference.
 *
 *    5) In the current verison, if your platform can't represent
 *       int32_t, int16_t and int8_t, it just dumps out with a compiler
 *       error.
 *
 *    6) 64 bit integers may or may not be defined.  Test for their
 *       presence with the test: #ifdef INT64_MAX or #ifdef UINT64_MAX.
 *       Note that this is different from the C99 specification which
 *       requires the existence of 64 bit support in the compiler.  If
 *       this is not defined for your platform, yet it is capable of
 *       dealing with 64 bits then it is because this file has not yet
 *       been extended to cover all of your system's capabilities.
 *
 *    7) (u)intptr_t may or may not be defined.  Test for its presence
 *       with the test: #ifdef PTRDIFF_MAX.  If this is not defined
 *       for your platform, then it is because this file has not yet
 *       been extended to cover all of your system's capabilities, not
 *       because its optional.
 *
 *    8) The following might not been defined even if your platform is
 *       capable of defining it:
 *
 *       WCHAR_MIN
 *       WCHAR_MAX
 *       (u)int64_t
 *       PTRDIFF_MIN
 *       PTRDIFF_MAX
 *       (u)intptr_t
 *
 *    9) The following have not been defined:
 *
 *       WINT_MIN
 *       WINT_MAX
 *
 *   10) The criteria for defining (u)int_least(*)_t isn't clear,
 *       except for systems which don't have a type that precisely
 *       defined 8, 16, or 32 bit types (which this include file does
 *       not support anyways). Default definitions have been given.
 *
 *   11) The criteria for defining (u)int_fast(*)_t isn't something I
 *       would trust to any particular compiler vendor or the ANSI C
 *       committee.  It is well known that "compatible systems" are
 *       commonly created that have very different performance
 *       characteristics from the systems they are compatible with,
 *       especially those whose vendors make both the compiler and the
 *       system.  Default definitions have been given, but its strongly
 *       recommended that users never use these definitions for any
 *       reason (they do *NOT* deliver any serious guarantee of
 *       improved performance -- not in this file, nor any vendor's
 *       stdint.h).
 *
 *   12) The following macros:
 *
 *       PRINTF_INTMAX_MODIFIER
 *       PRINTF_INT64_MODIFIER
 *       PRINTF_INT32_MODIFIER
 *       PRINTF_INT16_MODIFIER
 *       PRINTF_LEAST64_MODIFIER
 *       PRINTF_LEAST32_MODIFIER
 *       PRINTF_LEAST16_MODIFIER
 *       PRINTF_INTPTR_MODIFIER
 *
 *       are strings which have been defined as the modifiers required
 *       for the "d", "u" and "x" printf formats to correctly output
 *       (u)intmax_t, (u)int64_t, (u)int32_t, (u)int16_t, (u)least64_t,
 *       (u)least32_t, (u)least16_t and (u)intptr_t types respectively.
 *       PRINTF_INTPTR_MODIFIER is not defined for some systems which
 *       provide their own stdint.h.  PRINTF_INT64_MODIFIER is not
 *       defined if INT64_MAX is not defined.  These are an extension
 *       beyond what C99 specifies must be in stdint.h.
 *
 *       In addition, the following macros are defined:
 *
 *       PRINTF_INTMAX_HEX_WIDTH
 *       PRINTF_INT64_HEX_WIDTH
 *       PRINTF_INT32_HEX_WIDTH
 *       PRINTF_INT16_HEX_WIDTH
 *       PRINTF_INT8_HEX_WIDTH
 *       PRINTF_INTMAX_DEC_WIDTH
 *       PRINTF_INT64_DEC_WIDTH
 *       PRINTF_INT32_DEC_WIDTH
 *       PRINTF_INT16_DEC_WIDTH
 *       PRINTF_UINT8_DEC_WIDTH
 *       PRINTF_UINTMAX_DEC_WIDTH
 *       PRINTF_UINT64_DEC_WIDTH
 *       PRINTF_UINT32_DEC_WIDTH
 *       PRINTF_UINT16_DEC_WIDTH
 *       PRINTF_UINT8_DEC_WIDTH
 *
 *       Which specifies the maximum number of characters required to
 *       print the number of that type in either hexadecimal or decimal.
 *       These are an extension beyond what C99 specifies must be in
 *       stdint.h.
 *
 *  Compilers tested (all with 0 warnings at their highest respective
 *  settings): Borland Turbo C 2.0, WATCOM C/C++ 11.0 (16 bits and 32
 *  bits), Microsoft Visual C++ 6.0 (32 bit), Microsoft Visual Studio
 *  .net (VC7), Intel C++ 4.0, GNU gcc v3.3.3
 *
 *  This file should be considered a work in progress.  Suggestions for
 *  improvements, especially those which increase coverage are strongly
 *  encouraged.
 *
 *  Acknowledgements
 *
 *  The following people have made significant contributions to the
 *  development and testing of this file:
 *
 *  Chris Howie
 *  John Steele Scott
 *  Dave Thorup
 *  John Dill
 *  Florian Wobbe
 *  Christopher Sean Morrison
 *  Mikkel Fahnoe Jorgensen
 *
 */

#include <stddef.h>
#include <limits.h>
#include <signal.h>

/*
 *  For gcc with _STDINT_H, fill in the PRINTF_INT*_MODIFIER macros, and
 *  do nothing else.  On the Mac OS X version of gcc this is _STDINT_H_.
 */

#if ((defined(_MSC_VER) && _MSC_VER >= 1600) || (defined(__STDC__) && __STDC__ && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 199901L) || (defined (__WATCOMC__) && (defined (_STDINT_H_INCLUDED) || __WATCOMC__ >= 1250)) || (defined(__GNUC__) && (__GNUC__ > 3 || defined(_STDINT_H) || defined(_STDINT_H_) || defined (__UINT_FAST64_TYPE__)) )) && !defined (_PSTDINT_H_INCLUDED) && !defined (NTDDI_VERSION)
#include <stdint.h>
#define _PSTDINT_H_INCLUDED
# if defined(__GNUC__) && (defined(__x86_64__) || defined(__ppc64__)) && !(defined(__APPLE__) && defined(__MACH__))
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "l"
#  endif
#  ifndef PRINTF_INT32_MODIFIER
#   define PRINTF_INT32_MODIFIER ""
#  endif
# else
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "ll"
#  endif
#  ifndef PRINTF_INT32_MODIFIER
#   if (UINT_MAX == UINT32_MAX)
#    define PRINTF_INT32_MODIFIER ""
#   else
#    define PRINTF_INT32_MODIFIER "l"
#   endif
#  endif
# endif
# ifndef PRINTF_INT16_MODIFIER
#  define PRINTF_INT16_MODIFIER "h"
# endif
# ifndef PRINTF_INTMAX_MODIFIER
#  define PRINTF_INTMAX_MODIFIER PRINTF_INT64_MODIFIER
# endif
# ifndef PRINTF_INT64_HEX_WIDTH
#  define PRINTF_INT64_HEX_WIDTH "16"
# endif
# ifndef PRINTF_UINT64_HEX_WIDTH
#  define PRINTF_UINT64_HEX_WIDTH "16"
# endif
# ifndef PRINTF_INT32_HEX_WIDTH
#  define PRINTF_INT32_HEX_WIDTH "8"
# endif
# ifndef PRINTF_UINT32_HEX_WIDTH
#  define PRINTF_UINT32_HEX_WIDTH "8"
# endif
# ifndef PRINTF_INT16_HEX_WIDTH
#  define PRINTF_INT16_HEX_WIDTH "4"
# endif
# ifndef PRINTF_UINT16_HEX_WIDTH
#  define PRINTF_UINT16_HEX_WIDTH "4"
# endif
# ifndef PRINTF_INT8_HEX_WIDTH
#  define PRINTF_INT8_HEX_WIDTH "2"
# endif
# ifndef PRINTF_UINT8_HEX_WIDTH
#  define PRINTF_UINT8_HEX_WIDTH "2"
# endif
# ifndef PRINTF_INT64_DEC_WIDTH
#  define PRINTF_INT64_DEC_WIDTH "19"
# endif
# ifndef PRINTF_UINT64_DEC_WIDTH
#  define PRINTF_UINT64_DEC_WIDTH "20"
# endif
# ifndef PRINTF_INT32_DEC_WIDTH
#  define PRINTF_INT32_DEC_WIDTH "10"
# endif
# ifndef PRINTF_UINT32_DEC_WIDTH
#  define PRINTF_UINT32_DEC_WIDTH "10"
# endif
# ifndef PRINTF_INT16_DEC_WIDTH
#  define PRINTF_INT16_DEC_WIDTH "5"
# endif
# ifndef PRINTF_UINT16_DEC_WIDTH
#  define PRINTF_UINT16_DEC_WIDTH "5"
# endif
# ifndef PRINTF_INT8_DEC_WIDTH
#  define PRINTF_INT8_DEC_WIDTH "3"
# endif
# ifndef PRINTF_UINT8_DEC_WIDTH
#  define PRINTF_UINT8_DEC_WIDTH "3"
# endif
# ifndef PRINTF_INTMAX_HEX_WIDTH
#  define PRINTF_INTMAX_HEX_WIDTH PRINTF_UINT64_HEX_WIDTH
# endif
# ifndef PRINTF_UINTMAX_HEX_WIDTH
#  define PRINTF_UINTMAX_HEX_WIDTH PRINTF_UINT64_HEX_WIDTH
# endif
# ifndef PRINTF_INTMAX_DEC_WIDTH
#  define PRINTF_INTMAX_DEC_WIDTH PRINTF_UINT64_DEC_WIDTH
# endif
# ifndef PRINTF_UINTMAX_DEC_WIDTH
#  define PRINTF_UINTMAX_DEC_WIDTH PRINTF_UINT64_DEC_WIDTH
# endif

/*
 *  Something really weird is going on with Open Watcom.  Just pull some of
 *  these duplicated definitions from Open Watcom's stdint.h file for now.
 */

# if defined (__WATCOMC__) && __WATCOMC__ >= 1250
#  if !defined (INT64_C)
#   define INT64_C(x)   (x + (INT64_MAX - INT64_MAX))
#  endif
#  if !defined (UINT64_C)
#   define UINT64_C(x)  (x + (UINT64_MAX - UINT64_MAX))
#  endif
#  if !defined (INT32_C)
#   define INT32_C(x)   (x + (INT32_MAX - INT32_MAX))
#  endif
#  if !defined (UINT32_C)
#   define UINT32_C(x)  (x + (UINT32_MAX - UINT32_MAX))
#  endif
#  if !defined (INT16_C)
#   define INT16_C(x)   (x)
#  endif
#  if !defined (UINT16_C)
#   define UINT16_C(x)  (x)
#  endif
#  if !defined (INT8_C)
#   define INT8_C(x)   (x)
#  endif
#  if !defined (UINT8_C)
#   define UINT8_C(x)  (x)
#  endif
#  if !defined (UINT64_MAX)
#   define UINT64_MAX  18446744073709551615ULL
#  endif
#  if !defined (INT64_MAX)
#   define INT64_MAX  9223372036854775807LL
#  endif
#  if !defined (UINT32_MAX)
#   define UINT32_MAX  4294967295UL
#  endif
#  if !defined (INT32_MAX)
#   define INT32_MAX  2147483647L
#  endif
#  if !defined (INTMAX_MAX)
#   define INTMAX_MAX INT64_MAX
#  endif
#  if !defined (INTMAX_MIN)
#   define INTMAX_MIN INT64_MIN
#  endif
# endif
#endif

#ifndef _PSTDINT_H_INCLUDED
#define _PSTDINT_H_INCLUDED

#ifndef SIZE_MAX
# define SIZE_MAX (~(size_t)0)
#endif

/*
 *  Deduce the type assignments from limits.h under the assumption that
 *  integer sizes in bits are powers of 2, and follow the ANSI
 *  definitions.
 */

#ifndef UINT8_MAX
# define UINT8_MAX 0xff
#endif
#if !defined(uint8_t) && !defined(_UINT8_T)
# if (UCHAR_MAX == UINT8_MAX) || defined (S_SPLINT_S)
    typedef unsigned char uint8_t;
#   define UINT8_C(v) ((uint8_t) v)
# else
#   error "Platform not supported"
# endif
#endif

#ifndef INT8_MAX
# define INT8_MAX 0x7f
#endif
#ifndef INT8_MIN
# define INT8_MIN INT8_C(0x80)
#endif
#if !defined(int8_t) && !defined(_INT8_T)
# if (SCHAR_MAX == INT8_MAX) || defined (S_SPLINT_S)
    typedef signed char int8_t;
#   define INT8_C(v) ((int8_t) v)
# else
#   error "Platform not supported"
# endif
#endif

#ifndef UINT16_MAX
# define UINT16_MAX 0xffff
#endif
#if !defined(uint16_t) && !defined(_UINT16_T)
#if (UINT_MAX == UINT16_MAX) || defined (S_SPLINT_S)
  typedef unsigned int uint16_t;
# ifndef PRINTF_INT16_MODIFIER
#  define PRINTF_INT16_MODIFIER ""
# endif
# define UINT16_C(v) ((uint16_t) (v))
#elif (USHRT_MAX == UINT16_MAX)
  typedef unsigned short uint16_t;
# define UINT16_C(v) ((uint16_t) (v))
# ifndef PRINTF_INT16_MODIFIER
#  define PRINTF_INT16_MODIFIER "h"
# endif
#else
#error "Platform not supported"
#endif
#endif

#ifndef INT16_MAX
# define INT16_MAX 0x7fff
#endif
#ifndef INT16_MIN
# define INT16_MIN INT16_C(0x8000)
#endif
#if !defined(int16_t) && !defined(_INT16_T)
#if (INT_MAX == INT16_MAX) || defined (S_SPLINT_S)
  typedef signed int int16_t;
# define INT16_C(v) ((int16_t) (v))
# ifndef PRINTF_INT16_MODIFIER
#  define PRINTF_INT16_MODIFIER ""
# endif
#elif (SHRT_MAX == INT16_MAX)
  typedef signed short int16_t;
# define INT16_C(v) ((int16_t) (v))
# ifndef PRINTF_INT16_MODIFIER
#  define PRINTF_INT16_MODIFIER "h"
# endif
#else
#error "Platform not supported"
#endif
#endif

#ifndef UINT32_MAX
# define UINT32_MAX (0xffffffffUL)
#endif
#if !defined(uint32_t) && !defined(_UINT32_T)
#if (ULONG_MAX == UINT32_MAX) || defined (S_SPLINT_S)
  typedef unsigned long uint32_t;
# define UINT32_C(v) v ## UL
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER "l"
# endif
#elif (UINT_MAX == UINT32_MAX)
  typedef unsigned int uint32_t;
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER ""
# endif
# define UINT32_C(v) v ## U
#elif (USHRT_MAX == UINT32_MAX)
  typedef unsigned short uint32_t;
# define UINT32_C(v) ((unsigned short) (v))
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER ""
# endif
#else
#error "Platform not supported"
#endif
#endif

#ifndef INT32_MAX
# define INT32_MAX (0x7fffffffL)
#endif
#ifndef INT32_MIN
# define INT32_MIN INT32_C(0x80000000)
#endif
#if !defined(int32_t) && !defined(_INT32_T)
#if (LONG_MAX == INT32_MAX) || defined (S_SPLINT_S)
  typedef signed long int32_t;
# define INT32_C(v) v ## L
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER "l"
# endif
#elif (INT_MAX == INT32_MAX)
  typedef signed int int32_t;
# define INT32_C(v) v
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER ""
# endif
#elif (SHRT_MAX == INT32_MAX)
  typedef signed short int32_t;
# define INT32_C(v) ((short) (v))
# ifndef PRINTF_INT32_MODIFIER
#  define PRINTF_INT32_MODIFIER ""
# endif
#else
#error "Platform not supported"
#endif
#endif

/*
 *  The macro stdint_int64_defined is temporarily used to record
 *  whether or not 64 integer support is available.  It must be
 *  defined for any 64 integer extensions for new platforms that are
 *  added.
 */

#undef stdint_int64_defined
#if (defined(__STDC__) && defined(__STDC_VERSION__)) || defined (S_SPLINT_S)
# if (__STDC__ && __STDC_VERSION__ >= 199901L) || defined (S_SPLINT_S)
#  define stdint_int64_defined
   typedef long long int64_t;
   typedef unsigned long long uint64_t;
#  define UINT64_C(v) v ## ULL
#  define  INT64_C(v) v ## LL
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "ll"
#  endif
# endif
#endif

#if !defined (stdint_int64_defined)
# if defined(__GNUC__)
#  define stdint_int64_defined
   __extension__ typedef long long int64_t;
   __extension__ typedef unsigned long long uint64_t;
#  define UINT64_C(v) v ## ULL
#  define  INT64_C(v) v ## LL
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "ll"
#  endif
# elif defined(__MWERKS__) || defined (__SUNPRO_C) || defined (__SUNPRO_CC) || defined (__APPLE_CC__) || defined (_LONG_LONG) || defined (_CRAYC) || defined (S_SPLINT_S)
#  define stdint_int64_defined
   typedef long long int64_t;
   typedef unsigned long long uint64_t;
#  define UINT64_C(v) v ## ULL
#  define  INT64_C(v) v ## LL
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "ll"
#  endif
# elif (defined(__WATCOMC__) && defined(__WATCOM_INT64__)) || (defined(_MSC_VER) && _INTEGRAL_MAX_BITS >= 64) || (defined (__BORLANDC__) && __BORLANDC__ > 0x460) || defined (__alpha) || defined (__DECC)
#  define stdint_int64_defined
   typedef __int64 int64_t;
   typedef unsigned __int64 uint64_t;
#  define UINT64_C(v) v ## UI64
#  define  INT64_C(v) v ## I64
#  ifndef PRINTF_INT64_MODIFIER
#   define PRINTF_INT64_MODIFIER "I64"
#  endif
# endif
#endif

#if !defined (LONG_LONG_MAX) && defined (INT64_C)
# define LONG_LONG_MAX INT64_C (9223372036854775807)
#endif
#ifndef ULONG_LONG_MAX
# define ULONG_LONG_MAX UINT64_C (18446744073709551615)
#endif

#if !defined (INT64_MAX) && defined (INT64_C)
# define INT64_MAX INT64_C (9223372036854775807)
#endif
#if !defined (INT64_MIN) && defined (INT64_C)
# define INT64_MIN INT64_C (-9223372036854775808)
#endif
#if !defined (UINT64_MAX) && defined (INT64_C)
# define UINT64_MAX UINT64_C (18446744073709551615)
#endif

/*
 *  Width of hexadecimal for number field.
 */

#ifndef PRINTF_INT64_HEX_WIDTH
# define PRINTF_INT64_HEX_WIDTH "16"
#endif
#ifndef PRINTF_INT32_HEX_WIDTH
# define PRINTF_INT32_HEX_WIDTH "8"
#endif
#ifndef PRINTF_INT16_HEX_WIDTH
# define PRINTF_INT16_HEX_WIDTH "4"
#endif
#ifndef PRINTF_INT8_HEX_WIDTH
# define PRINTF_INT8_HEX_WIDTH "2"
#endif
#ifndef PRINTF_INT64_DEC_WIDTH
# define PRINTF_INT64_DEC_WIDTH "19"
#endif
#ifndef PRINTF_INT32_DEC_WIDTH
# define PRINTF_INT32_DEC_WIDTH "10"
#endif
#ifndef PRINTF_INT16_DEC_WIDTH
# define PRINTF_INT16_DEC_WIDTH "5"
#endif
#ifndef PRINTF_INT8_DEC_WIDTH
# define PRINTF_INT8_DEC_WIDTH "3"
#endif
#ifndef PRINTF_UINT64_DEC_WIDTH
# define PRINTF_UINT64_DEC_WIDTH "20"
#endif
#ifndef PRINTF_UINT32_DEC_WIDTH
# define PRINTF_UINT32_DEC_WIDTH "10"
#endif
#ifndef PRINTF_UINT16_DEC_WIDTH
# define PRINTF_UINT16_DEC_WIDTH "5"
#endif
#ifndef PRINTF_UINT8_DEC_WIDTH
# define PRINTF_UINT8_DEC_WIDTH "3"
#endif

/*
 *  Ok, lets not worry about 128 bit integers for now.  Moore's law says
 *  we don't need to worry about that until about 2040 at which point
 *  we'll have bigger things to worry about.
 */

#ifdef stdint_int64_defined
  typedef int64_t intmax_t;
  typedef uint64_t uintmax_t;
# define  INTMAX_MAX   INT64_MAX
# define  INTMAX_MIN   INT64_MIN
# define UINTMAX_MAX  UINT64_MAX
# define UINTMAX_C(v) UINT64_C(v)
# define  INTMAX_C(v)  INT64_C(v)
# ifndef PRINTF_INTMAX_MODIFIER
#   define PRINTF_INTMAX_MODIFIER PRINTF_INT64_MODIFIER
# endif
# ifndef PRINTF_INTMAX_HEX_WIDTH
#  define PRINTF_INTMAX_HEX_WIDTH PRINTF_INT64_HEX_WIDTH
# endif
# ifndef PRINTF_INTMAX_DEC_WIDTH
#  define PRINTF_INTMAX_DEC_WIDTH PRINTF_INT64_DEC_WIDTH
# endif
#else
  typedef int32_t intmax_t;
  typedef uint32_t uintmax_t;
# define  INTMAX_MAX   INT32_MAX
# define UINTMAX_MAX  UINT32_MAX
# define UINTMAX_C(v) UINT32_C(v)
# define  INTMAX_C(v)  INT32_C(v)
# ifndef PRINTF_INTMAX_MODIFIER
#   define PRINTF_INTMAX_MODIFIER PRINTF_INT32_MODIFIER
# endif
# ifndef PRINTF_INTMAX_HEX_WIDTH
#  define PRINTF_INTMAX_HEX_WIDTH PRINTF_INT32_HEX_WIDTH
# endif
# ifndef PRINTF_INTMAX_DEC_WIDTH
#  define PRINTF_INTMAX_DEC_WIDTH PRINTF_INT32_DEC_WIDTH
# endif
#endif

/*
 *  Because this file currently only supports platforms which have
 *  precise powers of 2 as bit sizes for the default integers, the
 *  least definitions are all trivial.  Its possible that a future
 *  version of this file could have different definitions.
 */

#ifndef stdint_least_defined
  typedef   int8_t   int_least8_t;
  typedef  uint8_t  uint_least8_t;
  typedef  int16_t  int_least16_t;
  typedef uint16_t uint_least16_t;
  typedef  int32_t  int_least32_t;
  typedef uint32_t uint_least32_t;
# define PRINTF_LEAST32_MODIFIER PRINTF_INT32_MODIFIER
# define PRINTF_LEAST16_MODIFIER PRINTF_INT16_MODIFIER
# define  UINT_LEAST8_MAX  UINT8_MAX
# define   INT_LEAST8_MAX   INT8_MAX
# define UINT_LEAST16_MAX UINT16_MAX
# define  INT_LEAST16_MAX  INT16_MAX
# define UINT_LEAST32_MAX UINT32_MAX
# define  INT_LEAST32_MAX  INT32_MAX
# define   INT_LEAST8_MIN   INT8_MIN
# define  INT_LEAST16_MIN  INT16_MIN
# define  INT_LEAST32_MIN  INT32_MIN
# ifdef stdint_int64_defined
    typedef  int64_t  int_least64_t;
    typedef uint64_t uint_least64_t;
#   define PRINTF_LEAST64_MODIFIER PRINTF_INT64_MODIFIER
#   define UINT_LEAST64_MAX UINT64_MAX
#   define  INT_LEAST64_MAX  INT64_MAX
#   define  INT_LEAST64_MIN  INT64_MIN
# endif
#endif
#undef stdint_least_defined

/*
 *  The ANSI C committee pretending to know or specify anything about
 *  performance is the epitome of misguided arrogance.  The mandate of
 *  this file is to *ONLY* ever support that absolute minimum
 *  definition of the fast integer types, for compatibility purposes.
 *  No extensions, and no attempt to suggest what may or may not be a
 *  faster integer type will ever be made in this file.  Developers are
 *  warned to stay away from these types when using this or any other
 *  stdint.h.
 */

typedef   int_least8_t   int_fast8_t;
typedef  uint_least8_t  uint_fast8_t;
typedef  int_least16_t  int_fast16_t;
typedef uint_least16_t uint_fast16_t;
typedef  int_least32_t  int_fast32_t;
typedef uint_least32_t uint_fast32_t;
#define  UINT_FAST8_MAX  UINT_LEAST8_MAX
#define   INT_FAST8_MAX   INT_LEAST8_MAX
#define UINT_FAST16_MAX UINT_LEAST16_MAX
#define  INT_FAST16_MAX  INT_LEAST16_MAX
#define UINT_FAST32_MAX UINT_LEAST32_MAX
#define  INT_FAST32_MAX  INT_LEAST32_MAX
#define   INT_FAST8_MIN   INT_LEAST8_MIN
#define  INT_FAST16_MIN  INT_LEAST16_MIN
#define  INT_FAST32_MIN  INT_LEAST32_MIN
#ifdef stdint_int64_defined
  typedef  int_least64_t  int_fast64_t;
  typedef uint_least64_t uint_fast64_t;
# define UINT_FAST64_MAX UINT_LEAST64_MAX
# define  INT_FAST64_MAX  INT_LEAST64_MAX
# define  INT_FAST64_MIN  INT_LEAST64_MIN
#endif

#undef stdint_int64_defined

/*
 *  Whatever piecemeal, per compiler thing we can do about the wchar_t
 *  type limits.
 */

#if defined(__WATCOMC__) || defined(_MSC_VER) || defined (__GNUC__)
# include <wchar.h>
# ifndef WCHAR_MIN
#  define WCHAR_MIN 0
# endif
# ifndef WCHAR_MAX
#  define WCHAR_MAX ((wchar_t)-1)
# endif
#endif

/*
 *  Whatever piecemeal, per compiler/platform thing we can do about the
 *  (u)intptr_t types and limits.
 */

#if (defined (_MSC_VER) && defined (_UINTPTR_T_DEFINED)) || defined (_UINTPTR_T)
# define STDINT_H_UINTPTR_T_DEFINED
#endif

#ifndef STDINT_H_UINTPTR_T_DEFINED
# if defined (__alpha__) || defined (__ia64__) || defined (__x86_64__) || defined (_WIN64) || defined (__ppc64__)
#  define stdint_intptr_bits 64
# elif defined (__WATCOMC__) || defined (__TURBOC__)
#  if defined(__TINY__) || defined(__SMALL__) || defined(__MEDIUM__)
#    define stdint_intptr_bits 16
#  else
#    define stdint_intptr_bits 32
#  endif
# elif defined (__i386__) || defined (_WIN32) || defined (WIN32) || defined (__ppc64__)
#  define stdint_intptr_bits 32
# elif defined (__INTEL_COMPILER)
/* TODO -- what did Intel do about x86-64? */
# else
/* #error "This platform might not be supported yet" */
# endif

# ifdef stdint_intptr_bits
#  define stdint_intptr_glue3_i(a,b,c)  a##b##c
#  define stdint_intptr_glue3(a,b,c)    stdint_intptr_glue3_i(a,b,c)
#  ifndef PRINTF_INTPTR_MODIFIER
#    define PRINTF_INTPTR_MODIFIER      stdint_intptr_glue3(PRINTF_INT,stdint_intptr_bits,_MODIFIER)
#  endif
#  ifndef PTRDIFF_MAX
#    define PTRDIFF_MAX                 stdint_intptr_glue3(INT,stdint_intptr_bits,_MAX)
#  endif
#  ifndef PTRDIFF_MIN
#    define PTRDIFF_MIN                 stdint_intptr_glue3(INT,stdint_intptr_bits,_MIN)
#  endif
#  ifndef UINTPTR_MAX
#    define UINTPTR_MAX                 stdint_intptr_glue3(UINT,stdint_intptr_bits,_MAX)
#  endif
#  ifndef INTPTR_MAX
#    define INTPTR_MAX                  stdint_intptr_glue3(INT,stdint_intptr_bits,_MAX)
#  endif
#  ifndef INTPTR_MIN
#    define INTPTR_MIN                  stdint_intptr_glue3(INT,stdint_intptr_bits,_MIN)
#  endif
#  ifndef INTPTR_C
#    define INTPTR_C(x)                 stdint_intptr_glue3(INT,stdint_intptr_bits,_C)(x)
#  endif
#  ifndef UINTPTR_C
#    define UINTPTR_C(x)                stdint_intptr_glue3(UINT,stdint_intptr_bits,_C)(x)
#  endif
  typedef stdint_intptr_glue3(uint,stdint_intptr_bits,_t) uintptr_t;
  typedef stdint_intptr_glue3( int,stdint_intptr_bits,_t)  intptr_t;
# else
/* TODO -- This following is likely wrong for some platforms, and does
   nothing for the definition of uintptr_t. */
  typedef ptrdiff_t intptr_t;
# endif
# define STDINT_H_UINTPTR_T_DEFINED
#endif

/*
 *  Assumes sig_atomic_t is signed and we have a 2s complement machine.
 */

#ifndef SIG_ATOMIC_MAX
# define SIG_ATOMIC_MAX ((((sig_atomic_t) 1) << (sizeof (sig_atomic_t)*CHAR_BIT-1)) - 1)
#endif

#endif

#if defined (__TEST_PSTDINT_FOR_CORRECTNESS)

/*
 *  Please compile with the maximum warning settings to make sure macros are
 *  not defined more than once.
 */

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define glue3_aux(x,y,z) x ## y ## z
#define glue3(x,y,z) glue3_aux(x,y,z)

#define DECLU(bits) glue3(uint,bits,_t) glue3(u,bits,) = glue3(UINT,bits,_C) (0);
#define DECLI(bits) glue3(int,bits,_t) glue3(i,bits,) = glue3(INT,bits,_C) (0);

#define DECL(us,bits) glue3(DECL,us,) (bits)

#define TESTUMAX(bits) glue3(u,bits,) = ~glue3(u,bits,); if (glue3(UINT,bits,_MAX) != glue3(u,bits,)) printf ("Something wrong with UINT%d_MAX\n", bits)

#define REPORTERROR(msg) { err_n++; if (err_first <= 0) err_first = __LINE__; printf msg; }

int main () {
	int err_n = 0;
	int err_first = 0;
	DECL(I,8)
	DECL(U,8)
	DECL(I,16)
	DECL(U,16)
	DECL(I,32)
	DECL(U,32)
#ifdef INT64_MAX
	DECL(I,64)
	DECL(U,64)
#endif
	intmax_t imax = INTMAX_C(0);
	uintmax_t umax = UINTMAX_C(0);
	char str0[256], str1[256];

	sprintf (str0, "%" PRINTF_INT32_MODIFIER "d", INT32_C(2147483647));
	if (0 != strcmp (str0, "2147483647")) REPORTERROR (("Something wrong with PRINTF_INT32_MODIFIER : %s\n", str0));
	if (atoi(PRINTF_INT32_DEC_WIDTH) != (int) strlen(str0)) REPORTERROR (("Something wrong with PRINTF_INT32_DEC_WIDTH : %s\n", PRINTF_INT32_DEC_WIDTH));
	sprintf (str0, "%" PRINTF_INT32_MODIFIER "u", UINT32_C(4294967295));
	if (0 != strcmp (str0, "4294967295")) REPORTERROR (("Something wrong with PRINTF_INT32_MODIFIER : %s\n", str0));
	if (atoi(PRINTF_UINT32_DEC_WIDTH) != (int) strlen(str0)) REPORTERROR (("Something wrong with PRINTF_UINT32_DEC_WIDTH : %s\n", PRINTF_UINT32_DEC_WIDTH));
#ifdef INT64_MAX
	sprintf (str1, "%" PRINTF_INT64_MODIFIER "d", INT64_C(9223372036854775807));
	if (0 != strcmp (str1, "9223372036854775807")) REPORTERROR (("Something wrong with PRINTF_INT32_MODIFIER : %s\n", str1));
	if (atoi(PRINTF_INT64_DEC_WIDTH) != (int) strlen(str1)) REPORTERROR (("Something wrong with PRINTF_INT64_DEC_WIDTH : %s, %d\n", PRINTF_INT64_DEC_WIDTH, (int) strlen(str1)));
	sprintf (str1, "%" PRINTF_INT64_MODIFIER "u", UINT64_C(18446744073709550591));
	if (0 != strcmp (str1, "18446744073709550591")) REPORTERROR (("Something wrong with PRINTF_INT32_MODIFIER : %s\n", str1));
	if (atoi(PRINTF_UINT64_DEC_WIDTH) != (int) strlen(str1)) REPORTERROR (("Something wrong with PRINTF_UINT64_DEC_WIDTH : %s, %d\n", PRINTF_UINT64_DEC_WIDTH, (int) strlen(str1)));
#endif

	sprintf (str0, "%d %x\n", 0, ~0);

	sprintf (str1, "%d %x\n",  i8, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with i8 : %s\n", str1));
	sprintf (str1, "%u %x\n",  u8, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with u8 : %s\n", str1));
	sprintf (str1, "%d %x\n",  i16, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with i16 : %s\n", str1));
	sprintf (str1, "%u %x\n",  u16, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with u16 : %s\n", str1));
	sprintf (str1, "%" PRINTF_INT32_MODIFIER "d %x\n",  i32, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with i32 : %s\n", str1));
	sprintf (str1, "%" PRINTF_INT32_MODIFIER "u %x\n",  u32, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with u32 : %s\n", str1));
#ifdef INT64_MAX
	sprintf (str1, "%" PRINTF_INT64_MODIFIER "d %x\n",  i64, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with i64 : %s\n", str1));
#endif
	sprintf (str1, "%" PRINTF_INTMAX_MODIFIER "d %x\n",  imax, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with imax : %s\n", str1));
	sprintf (str1, "%" PRINTF_INTMAX_MODIFIER "u %x\n",  umax, ~0);
	if (0 != strcmp (str0, str1)) REPORTERROR (("Something wrong with umax : %s\n", str1));

	TESTUMAX(8);
	TESTUMAX(16);
	TESTUMAX(32);
#ifdef INT64_MAX
	TESTUMAX(64);
#endif

#define STR(v) #v
#define Q(v) printf ("sizeof " STR(v) " = %u\n", (unsigned) sizeof (v));
	if (err_n) {
		printf ("pstdint.h is not correct.  Please use sizes below to correct it:\n");
	}

	Q(int)
	Q(unsigned)
	Q(long int)
	Q(short int)
	Q(int8_t)
	Q(int16_t)
	Q(int32_t)
#ifdef INT64_MAX
	Q(int64_t)
#endif

	return EXIT_SUCCESS;
}

#endif
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_punaligned_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_punaligned_h
/*
 * Copyright (c) 2016 Mikkel Fahnøe Jørgensen, dvide.com
 *
 * (MIT License)
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */

#ifndef PUNLIGNED_H
#define PUNLIGNED_H

#ifdef __cplusplus
extern "C" {
#endif

#ifndef PORTABLE_UNALIGNED_ACCESS

#if defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64)
#define PORTABLE_UNALIGNED_ACCESS 1
#else
#define PORTABLE_UNALIGNED_ACCESS 0
#endif

#endif

/* `unaligned_read_16` might not be defined if endianness was not determined. */
#if !defined(unaligned_read_le16toh)
#define JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h 1
#include "nanoarrow/flatcc.h"
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pendian_h

#ifndef UINT8_MAX
#include <stdint.h>
#endif

#if PORTABLE_UNALIGNED_ACCESS

#define unaligned_read_16(p) (*(uint16_t*)(p))
#define unaligned_read_32(p) (*(uint32_t*)(p))
#define unaligned_read_64(p) (*(uint64_t*)(p))

#define unaligned_read_le16toh(p) le16toh(*(uint16_t*)(p))
#define unaligned_read_le32toh(p) le32toh(*(uint32_t*)(p))
#define unaligned_read_le64toh(p) le64toh(*(uint64_t*)(p))

#define unaligned_read_be16toh(p) be16toh(*(uint16_t*)(p))
#define unaligned_read_be32toh(p) be32toh(*(uint32_t*)(p))
#define unaligned_read_be64toh(p) be64toh(*(uint64_t*)(p))

#define unaligned_write_16(p, v) (*(uint16_t*)(p) = (uint16_t)(v))
#define unaligned_write_32(p, v) (*(uint32_t*)(p) = (uint32_t)(v))
#define unaligned_write_64(p, v) (*(uint64_t*)(p) = (uint64_t)(v))

#define unaligned_write_htole16(p, v) (*(uint16_t*)(p) = htole16(v))
#define unaligned_write_htole32(p, v) (*(uint32_t*)(p) = htole32(v))
#define unaligned_write_htole64(p, v) (*(uint64_t*)(p) = htole64(v))

#define unaligned_write_htobe16(p, v) (*(uint16_t*)(p) = htobe16(v))
#define unaligned_write_htobe32(p, v) (*(uint32_t*)(p) = htobe32(v))
#define unaligned_write_htobe64(p, v) (*(uint64_t*)(p) = htobe64(v))

#else

#define unaligned_read_le16toh(p)  (                                        \
        (((uint16_t)(((uint8_t *)(p))[0])) <<  0) |                         \
        (((uint16_t)(((uint8_t *)(p))[1])) <<  8))

#define unaligned_read_le32toh(p)  (                                        \
        (((uint32_t)(((uint8_t *)(p))[0])) <<  0) |                         \
        (((uint32_t)(((uint8_t *)(p))[1])) <<  8) |                         \
        (((uint32_t)(((uint8_t *)(p))[2])) << 16) |                         \
        (((uint32_t)(((uint8_t *)(p))[3])) << 24))

#define unaligned_read_le64toh(p)  (                                        \
        (((uint64_t)(((uint8_t *)(p))[0])) <<  0) |                         \
        (((uint64_t)(((uint8_t *)(p))[1])) <<  8) |                         \
        (((uint64_t)(((uint8_t *)(p))[2])) << 16) |                         \
        (((uint64_t)(((uint8_t *)(p))[3])) << 24) |                         \
        (((uint64_t)(((uint8_t *)(p))[4])) << 32) |                         \
        (((uint64_t)(((uint8_t *)(p))[5])) << 40) |                         \
        (((uint64_t)(((uint8_t *)(p))[6])) << 48) |                         \
        (((uint64_t)(((uint8_t *)(p))[7])) << 56))

#define unaligned_read_be16toh(p)  (                                        \
        (((uint16_t)(((uint8_t *)(p))[0])) <<  8) |                         \
        (((uint16_t)(((uint8_t *)(p))[1])) <<  0))

#define unaligned_read_be32toh(p)  (                                        \
        (((uint32_t)(((uint8_t *)(p))[0])) << 24) |                         \
        (((uint32_t)(((uint8_t *)(p))[1])) << 16) |                         \
        (((uint32_t)(((uint8_t *)(p))[2])) <<  8) |                         \
        (((uint32_t)(((uint8_t *)(p))[3])) <<  0))

#define unaligned_read_be64toh(p)  (                                        \
        (((uint64_t)(((uint8_t *)(p))[0])) << 56) |                         \
        (((uint64_t)(((uint8_t *)(p))[1])) << 48) |                         \
        (((uint64_t)(((uint8_t *)(p))[2])) << 40) |                         \
        (((uint64_t)(((uint8_t *)(p))[3])) << 32) |                         \
        (((uint64_t)(((uint8_t *)(p))[4])) << 24) |                         \
        (((uint64_t)(((uint8_t *)(p))[5])) << 16) |                         \
        (((uint64_t)(((uint8_t *)(p))[6])) <<  8) |                         \
        (((uint64_t)(((uint8_t *)(p))[7])) <<  0))

#define unaligned_write_htole16(p, v) do {                                  \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint16_t)(v)) >>  0);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint16_t)(v)) >>  8);             \
        } while (0)

#define unaligned_write_htole32(p, v) do {                                  \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint32_t)(v)) >>  0);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint32_t)(v)) >>  8);             \
        ((uint8_t *)(p))[2] = (uint8_t)(((uint32_t)(v)) >> 16);             \
        ((uint8_t *)(p))[3] = (uint8_t)(((uint32_t)(v)) >> 24);             \
        } while (0)

#define unaligned_write_htole64(p, v) do {                                  \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint64_t)(v)) >>  0);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint64_t)(v)) >>  8);             \
        ((uint8_t *)(p))[2] = (uint8_t)(((uint64_t)(v)) >> 16);             \
        ((uint8_t *)(p))[3] = (uint8_t)(((uint64_t)(v)) >> 24);             \
        ((uint8_t *)(p))[4] = (uint8_t)(((uint64_t)(v)) >> 32);             \
        ((uint8_t *)(p))[5] = (uint8_t)(((uint64_t)(v)) >> 40);             \
        ((uint8_t *)(p))[6] = (uint8_t)(((uint64_t)(v)) >> 48);             \
        ((uint8_t *)(p))[7] = (uint8_t)(((uint64_t)(v)) >> 56);             \
        } while (0)

#define unaligned_write_htobe16(p, v) do {                                  \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint16_t)(v)) >>  8);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint16_t)(v)) >>  0);             \
        } while (0)

#define unaligned_write_htobe32(p, v) do {                                  \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint32_t)(v)) >> 24);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint32_t)(v)) >> 16);             \
        ((uint8_t *)(p))[2] = (uint8_t)(((uint32_t)(v)) >>  8);             \
        ((uint8_t *)(p))[3] = (uint8_t)(((uint32_t)(v)) >>  0);             \
        } while (0)

#define unaligned_write_htobe64(p) do {                                     \
        ((uint8_t *)(p))[0] = (uint8_t)(((uint64_t)(v)) >> 56);             \
        ((uint8_t *)(p))[1] = (uint8_t)(((uint64_t)(v)) >> 48);             \
        ((uint8_t *)(p))[2] = (uint8_t)(((uint64_t)(v)) >> 40);             \
        ((uint8_t *)(p))[3] = (uint8_t)(((uint64_t)(v)) >> 32);             \
        ((uint8_t *)(p))[4] = (uint8_t)(((uint64_t)(v)) >> 24);             \
        ((uint8_t *)(p))[5] = (uint8_t)(((uint64_t)(v)) >> 16);             \
        ((uint8_t *)(p))[6] = (uint8_t)(((uint64_t)(v)) >>  8);             \
        ((uint8_t *)(p))[7] = (uint8_t)(((uint64_t)(v)) >>  0);             \
        } while (0)

#if __LITTLE_ENDIAN__
#define unaligned_read_16(p) unaligned_read_le16toh(p)
#define unaligned_read_32(p) unaligned_read_le32toh(p)
#define unaligned_read_64(p) unaligned_read_le64toh(p)

#define unaligned_write_16(p) unaligned_write_htole16(p)
#define unaligned_write_32(p) unaligned_write_htole32(p)
#define unaligned_write_64(p) unaligned_write_htole64(p)
#endif

#if __BIG_ENDIAN__
#define unaligned_read_16(p) unaligned_read_be16toh(p)
#define unaligned_read_32(p) unaligned_read_be32toh(p)
#define unaligned_read_64(p) unaligned_read_be64toh(p)

#define unaligned_write_16(p) unaligned_write_htobe16(p)
#define unaligned_write_32(p) unaligned_write_htobe32(p)
#define unaligned_write_64(p) unaligned_write_htobe64(p)
#endif

#endif

#endif

#ifdef __cplusplus
}
#endif

#endif /* PUNALIGNED_H */
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pversion_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pversion_h
#define PORTABLE_VERSION_TEXT "0.2.6-pre"
#define PORTABLE_VERSION_MAJOR 0
#define PORTABLE_VERSION_MINOR 2
#define PORTABLE_VERSION_PATCH 6
/* 1 or 0 */
#define PORTABLE_VERSION_RELEASED 0
#endif
#if defined(JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h)
#undef JDV_FLATCC_INCLUDE_flatcc_portable_pwarnings_h
#ifndef PWARNINGS_H
#define PWARNINGS_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * See also pdiagnostics.h headers for per file control of common
 * warnings.
 *
 * This file is intended for global disabling of warnings that shouldn't
 * be present in C11 or perhaps C99, or a generally just noise where
 * recent clang / gcc compile cleanly with high warning levels.
 */

#if defined(_MSC_VER)
/* Needed when flagging code in or out and more. */
#pragma warning(disable: 4127) /* conditional expression is constant */
/* happens also in MS's own headers. */
#pragma warning(disable: 4668) /* preprocessor name not defined */
/* MSVC does not respect double parenthesis for intent */
#pragma warning(disable: 4706) /* assignment within conditional expression */
/* `inline` only advisory anyway. */
#pragma warning(disable: 4710) /* function not inlined */
/* Well, we don't intend to add the padding manually. */
#pragma warning(disable: 4820) /* x bytes padding added in struct */

/*
 * Don't warn that fopen etc. are unsafe
 *
 * Define a compiler flag like `-D_CRT_SECURE_NO_WARNINGS` in the build.
 * For some reason it doesn't work when defined here.
 *
 *     #define _CRT_SECURE_NO_WARNINGS
 */

/*
 * Anonymous union in struct is valid in C11 and has been supported in
 * GCC and Clang for a while, but it is not C99. MSVC also handles it,
 * but warns. Truly portable code should perhaps not use this feature,
 * but this is not the place to complain about it.
 */
#pragma warning(disable: 4201) /* nonstandard extension used: nameless struct/union */

#endif /* _MSV_VER */

#ifdef __cplusplus
}
#endif

#endif /* PWARNINGS_H */
#endif
