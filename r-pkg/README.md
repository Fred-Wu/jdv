# jdv (R package)

This directory contains the source code for the jdv R package, a lightweight
(C-based, zero dependency) data viewer for R.

For the viewer setup, examples, and everything else, please consult the main
project README: <https://github.com/eitsupi/jdv>

An embedding host can inspect a selected value through a handle and then
register the captured value as a regular view:

```r
root <- jdv::jdv_handle(list(mtcars))
child <- jdv::jdv_handle_open(root, list(list(type = "index", index = 1L)))
view <- jdv::jdv_handle_register(child)
jdv::jdv_handle_close(root)
jdv::jdv_close(view$id)
```

The registered view keeps its own captured value and remains open after the
handle closes.
