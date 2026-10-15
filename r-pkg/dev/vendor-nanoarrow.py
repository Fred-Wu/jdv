#!/usr/bin/env python3
"""Reproduce the pinned nanoarrow core + IPC + flatcc source bundle."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import posixpath
import re
import shutil
import subprocess
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[2]
UPSTREAM = ROOT / "refs/arrow-nanoarrow"
REVISION = "ea215b000788ec2e94fc88bad5249290c94b01cd"
NAMESPACE = "JdvNanoarrow_"
SELECTOR_PREFIX = "JDV_FLATCC_INCLUDE_"


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selector(path: str) -> str:
    return SELECTOR_PREFIX + re.sub(r"[^A-Za-z0-9]", "_", path)


def resolve_flatcc_include(include: str, current: pathlib.PurePosixPath) -> str | None:
    include_root = UPSTREAM / "thirdparty/flatcc/include"
    candidates = [
        posixpath.normpath(include),
        posixpath.normpath(posixpath.join(current.parent.as_posix(), include)),
        posixpath.normpath(posixpath.join("flatcc", include)),
    ]
    for candidate in candidates:
        if candidate.startswith("flatcc/") and (include_root / candidate).is_file():
            return candidate
    return None


def rewrite_includes(content: str, current: pathlib.PurePosixPath) -> str:
    pattern = re.compile(r'^(\s*#\s*include\s*)"([^"]+)"', re.MULTILINE)

    def replace(match: re.Match[str]) -> str:
        name = resolve_flatcc_include(match.group(2), current)
        if name is None:
            return match.group(0)
        macro = selector(name)
        return (
            f"#define {macro} 1\n"
            f"#include \"nanoarrow/flatcc.h\"\n"
            f"#undef {macro}"
        )

    return pattern.sub(replace, content)


def bundle(output: pathlib.Path) -> None:
    if not (UPSTREAM / "ci/scripts/bundle.py").is_file():
        raise SystemExit(f"Pinned checkout is missing: {UPSTREAM}")

    git_dir = UPSTREAM / ".git"
    if git_dir.is_file():
        git_dir_text = git_dir.read_text(encoding="utf-8").strip()
        if not git_dir_text.startswith("gitdir:"):
            raise SystemExit("Reference checkout has an invalid .git file")
        git_dir = pathlib.Path(git_dir_text.partition(":")[2].strip())
        if not git_dir.is_absolute():
            git_dir = UPSTREAM / git_dir
    head = (git_dir / "HEAD").read_text(encoding="ascii").strip()
    if head.startswith("ref: "):
        ref = head[5:]
        loose_ref = git_dir / ref
        if loose_ref.is_file():
            actual_revision = loose_ref.read_text(encoding="ascii").strip()
        else:
            packed_refs = git_dir / "packed-refs"
            actual_revision = next(
                (
                    line.split(" ", 1)[0]
                    for line in packed_refs.read_text(encoding="ascii").splitlines()
                    if line and not line.startswith(("#", "^")) and line.endswith(" " + ref)
                ),
                "",
            )
    else:
        actual_revision = head
    if actual_revision != REVISION:
        raise SystemExit(
            f"Expected pinned nanoarrow revision {REVISION}, got {actual_revision}"
        )

    with tempfile.TemporaryDirectory(prefix="jdv-nanoarrow-bundle-") as temp_name:
        temp = pathlib.Path(temp_name)
        raw = temp / "raw"
        subprocess.run(
            [
                "python3",
                str(UPSTREAM / "ci/scripts/bundle.py"),
                "--output-dir",
                str(raw),
                "--with-ipc",
                "--with-flatcc",
                "--symbol-namespace",
                NAMESPACE,
            ],
            cwd=UPSTREAM,
            check=True,
        )
        raw_bundle_files = sorted(path for path in raw.rglob("*") if path.is_file())
        raw_bundle_hashes = [
            f"{sha256(path)}  {path.relative_to(raw).as_posix()}\n"
            for path in raw_bundle_files
        ]

        flatcc_root = raw / "include"
        header_paths = sorted(
            pathlib.PurePosixPath(path.relative_to(raw / "include").as_posix())
            for path in (raw / "include").glob("flatcc/**/*.h")
        )
        blocks: list[str] = [
            "/* Mechanically aggregated from the pinned flatcc runtime headers. */\n"
        ]
        for relative in header_paths:
            input_path = flatcc_root / relative
            body = input_path.read_text(encoding="utf-8")
            body = rewrite_includes(body, relative)
            if relative.as_posix() == "flatcc/portable/pdiagnostic.h":
                # Match upstream r/bootstrap.R without changing pragma semantics.
                body = re.sub(r"^#pragma", "/**/#pragma", body, flags=re.MULTILINE)
            macro = selector(relative.as_posix())
            blocks.extend([f"#if defined({macro})\n", f"#undef {macro}\n", body])
            if not body.endswith("\n"):
                blocks.append("\n")
            blocks.append("#endif\n")

        (raw / "include/nanoarrow/flatcc.h").write_text(
            "".join(blocks), encoding="utf-8"
        )

        for path in list((raw / "include").glob("flatcc/**/*.h")):
            path.unlink()
        shutil.rmtree(raw / "include/flatcc")
        for path in (raw / "include").rglob("*.hpp"):
            path.unlink()

        for source in (raw / "src").glob("*.c"):
            content = source.read_text(encoding="utf-8")
            source.write_text(
                rewrite_includes(content, pathlib.PurePosixPath(source.name)),
                encoding="utf-8",
            )

        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(raw, output)

    shutil.copyfile(UPSTREAM / "LICENSE.txt", output / "LICENSE.txt")
    shutil.copyfile(UPSTREAM / "NOTICE.txt", output / "NOTICE.txt")
    shutil.copyfile(
        UPSTREAM / "thirdparty/flatcc/LICENSE", output / "flatcc-LICENSE.txt"
    )

    generated_files = sorted(
        path for path in output.rglob("*") if path.is_file()
    )
    input_paths = [
        "CMakeLists.txt",
        "LICENSE.txt",
        "NOTICE.txt",
        "ci/scripts/bundle.py",
        "r/bootstrap.R",
        "src/nanoarrow/nanoarrow_config.h.in",
        "src/nanoarrow/common/inline_types.h",
        "src/nanoarrow/common/inline_buffer.h",
        "src/nanoarrow/common/inline_array.h",
        "src/nanoarrow/nanoarrow.h",
        "src/nanoarrow/common/utils.c",
        "src/nanoarrow/common/schema.c",
        "src/nanoarrow/common/array.c",
        "src/nanoarrow/common/array_stream.c",
        "src/nanoarrow/nanoarrow_ipc.h",
        "src/nanoarrow/ipc/flatcc_generated.h",
        "src/nanoarrow/ipc/codecs.c",
        "src/nanoarrow/ipc/decoder.c",
        "src/nanoarrow/ipc/encoder.c",
        "src/nanoarrow/ipc/reader.c",
        "src/nanoarrow/ipc/writer.c",
        "thirdparty/flatcc/LICENSE",
        "thirdparty/flatcc/src/runtime/builder.c",
        "thirdparty/flatcc/src/runtime/emitter.c",
        "thirdparty/flatcc/src/runtime/verifier.c",
        "thirdparty/flatcc/src/runtime/refmap.c",
    ]
    input_paths.extend(
        path.relative_to(UPSTREAM).as_posix()
        for path in sorted((UPSTREAM / "thirdparty/flatcc/include").glob("flatcc/**/*.h"))
    )
    input_files = [UPSTREAM / path for path in sorted(set(input_paths))]

    provenance = [
        "# nanoarrow C bundle provenance",
        "",
        f"Source: Apache Arrow nanoarrow revision `{REVISION}` in `refs/arrow-nanoarrow`.",
        f"Namespace: `{NAMESPACE}` (the trailing underscore is intentional).",
        "",
        "Generation command (run from the repository root):",
        "",
        "```sh",
        "python3 refs/arrow-nanoarrow/ci/scripts/bundle.py \\",
        "  --output-dir RAW --with-ipc --with-flatcc \\",
        f"  --symbol-namespace {NAMESPACE}",
        "python3 r-pkg/dev/vendor-nanoarrow.py --output-dir r-pkg/src/nanoarrow",
        "```",
        "",
        "The output is generated by the official `bundle.py` command at the pinned revision. Its raw output is hashed before mechanical transformation. The two C++ `.hpp` wrappers are omitted because the R package builds C only. The 35 flatcc runtime `.h` files in the raw bundle are mechanically placed in `include/nanoarrow/flatcc.h`: each original header body remains within a selector block, and every local quoted flatcc include is replaced at its original location by a selector dispatch. Original include guards, conditional includes, intentional repeated prologue/epilogue includes, and platform branches remain in control. No C definitions or symbol names are edited. The three concatenated C sources use the same mechanical include dispatch for flatcc references. As in upstream `r/bootstrap.R`, lines beginning with `#pragma` in `flatcc/portable/pdiagnostic.h` are mechanically prefixed with `/**/` so R CMD check does not flag diagnostic pragmas. This does not alter preprocessing semantics.",
        "",
        "`SOURCE-SHA256SUMS` records pinned source inputs; `UPSTREAM-BUNDLE-SHA256SUMS` records all raw official bundle files before mechanical aggregation; `GENERATOR-SHA256SUMS` records this generator; and `SHA256SUMS` records final output and preserved license/notice files. `flatcc-LICENSE.txt` is the upstream flatcc license.",
        "",
    ]
    (output / "PROVENANCE.md").write_text("\n".join(provenance), encoding="utf-8")
    (output / "SOURCE-SHA256SUMS").write_text(
        "".join(
            f"{sha256(path)}  {path.relative_to(UPSTREAM).as_posix()}\n"
            for path in input_files
        ),
        encoding="utf-8",
    )
    (output / "UPSTREAM-BUNDLE-SHA256SUMS").write_text(
        "".join(raw_bundle_hashes), encoding="utf-8"
    )
    generator_hash = sha256(pathlib.Path(__file__).resolve())
    (output / "GENERATOR-SHA256SUMS").write_text(
        f"{generator_hash}  r-pkg/dev/vendor-nanoarrow.py\n", encoding="utf-8"
    )
    generated_files = sorted(
        path for path in output.rglob("*") if path.is_file() and path.name != "SHA256SUMS"
    )
    (output / "SHA256SUMS").write_text(
        "".join(
            f"{sha256(path)}  {path.relative_to(output).as_posix()}\n"
            for path in generated_files
        ),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=pathlib.Path,
        default=ROOT / "r-pkg/src/nanoarrow",
    )
    args = parser.parse_args()
    bundle(args.output_dir.resolve())


if __name__ == "__main__":
    main()
