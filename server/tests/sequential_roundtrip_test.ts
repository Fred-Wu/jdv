import { assert, assertEquals } from "./assert.ts";
import { sequentialCapabilities } from "./sequential_capabilities.ts";
import { decodeArrowPage } from "../web/sequential.js";

const library = Deno.env.get("JDV_TEST_R_LIB") ||
  Deno.env.get("JDV_TEST_BINARY_R_LIB");

const capabilities = await sequentialCapabilities(library);
if (library && (!capabilities.arrow || !capabilities.nanoarrow)) {
  console.info(
    "The Arrow roundtrip test requires the optional R arrow and nanoarrow packages.",
  );
}
if (library && !capabilities.polars) {
  console.info(
    "The optional Polars roundtrip test is skipped because the R polars package is unavailable.",
  );
}

async function roundtrip(polarsOnly = false) {
  const arrowModule = "npm:apache-arrow@21.2.0";
  const Arrow = await import(arrowModule);
  const work = await Deno.makeTempDir({
    prefix: "jdv-sequential-roundtrip-",
  });
  const script = `${work}/producer.R`;
  const common = [
    "args <- commandArgs(TRUE)",
    ".libPaths(c(args[[1]], .libPaths()))",
    "library(jdv)",
    "canonical_path <- function(x) { path <- normalizePath(x, winslash='/', mustWork=TRUE); if (.Platform$OS.type == 'windows') path <- tolower(path); sub('/+$', '', path) }",
    "path_within <- function(path, parent) identical(path, parent) || startsWith(path, paste0(parent, '/'))",
    "package_path <- canonical_path(find.package('jdv'))",
    "library_path <- canonical_path(args[[1]])",
    "dll_path <- canonical_path(getLoadedDLLs()[['jdv']][['path']])",
    "namespace_path <- canonical_path(getNamespaceInfo(asNamespace('jdv'), 'path'))",
    "stopifnot(path_within(package_path, library_path), path_within(dll_path, package_path), identical(namespace_path, package_path))",
    "write_page <- function(x, name) {",
    "  view <- jdv_register(x)",
    "  on.exit(jdv:::.jdv_close_internal(view$id, notify=FALSE))",
    "  writeLines(view$open, file.path(args[[2]], paste0(name, '.json')))",
    "  request <- jdv:::.jdv_json_encode(list(id='page', method='stream/next', params=list(view=view$id, generation=1, max_rows=2)))",
    "  packet <- jdv:::.jdv_rpc_internal(request, allow_binary=TRUE)",
    "  stopifnot(inherits(packet, 'jdv_binary_packet'))",
    "  writeBin(packet$payload, file.path(args[[2]], paste0(name, '.arrows')))",
    "  writeLines(packet$header, file.path(args[[2]], paste0(name, '-page.json')))",
    "}",
  ];
  const nested = [
    "columns <- list(",
    "  code=arrow::Array$create(factor(c('red','green')), type=arrow::dictionary(arrow::int8(),arrow::utf8())),",
    "  large=arrow::Array$create(list(c(1L,2L),integer()), type=arrow::large_list_of(arrow::int32())),",
    "  record=arrow::Array$create(data.frame(id=c(1L,2L),label=c('a','b')), type=arrow::struct(id=arrow::int32(),label=arrow::utf8())),",
    "  entries=arrow::Array$create(list(data.frame(key=c('a','b'),value=c(1L,2L)), data.frame(key=character(),value=integer())), type=arrow::map_of(arrow::utf8(),arrow::int32())),",
    "  payload=arrow::Array$create(c(7L,8L),type=arrow::int32())",
    ")",
    "fields <- Map(function(name,column) arrow::field(name,column$type), names(columns), columns)",
    "fields[[5]] <- arrow::field('payload',arrow::int32(),metadata=c('ARROW:extension:name'='org.example.jdv.test','ARROW:extension:metadata'='v1'))",
    "logical_schema <- do.call(arrow::schema,fields)$WithMetadata(list(origin='sequential-roundtrip'))",
    "value <- do.call(arrow::Table$create,c(columns,list(schema=logical_schema)))",
    "write_page(value,'nested')",
  ];
  const polarsSource = [
    "pl <- getExportedValue('polars','pl')",
    "frame <- pl$DataFrame(label=c('alpha','beta'), values=pl$Series('values',list(c('x','y'),character())))",
    "write_page(frame,'polars')",
  ];
  await Deno.writeTextFile(
    script,
    [...common, ...(polarsOnly ? polarsSource : nested)].join("\n"),
  );
  try {
    const process = await new Deno.Command("Rscript", {
      args: ["--vanilla", script, library!, work],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(process.code === 0, new TextDecoder().decode(process.stderr));
    if (!polarsOnly) {
      const descriptor =
        JSON.parse(await Deno.readTextFile(`${work}/nested.json`)).params;
      const page =
        JSON.parse(await Deno.readTextFile(`${work}/nested-page.json`)).result;
      const bytes = await Deno.readFile(`${work}/nested.arrows`);
      const table = Arrow.tableFromIPC(bytes);
      assertEquals(table.numRows, 2);
      assertEquals(
        table.schema.fields.map((field: { name: string }) => field.name),
        ["code", "large", "record", "entries", "payload"],
      );
      assertEquals(table.getChild("code")!.type.typeId, -1);
      assertEquals([
        table.getChild("code")!.get(0),
        table.getChild("code")!.get(1),
      ], ["red", "green"]);
      assertEquals(table.getChild("large")!.type.typeId, 21);
      assertEquals(Array.from(table.getChild("large")!.get(0)), [1, 2]);
      assertEquals(Array.from(table.getChild("large")!.get(1)), []);
      assertEquals(table.getChild("record")!.get(0).toJSON(), {
        id: 1,
        label: "a",
      });
      assertEquals(table.getChild("record")!.get(1).toJSON(), {
        id: 2,
        label: "b",
      });
      assertEquals(table.getChild("entries")!.get(0).toJSON(), { a: 1, b: 2 });
      assertEquals(table.getChild("entries")!.get(1).toJSON(), {});
      assertEquals(table.getChild("payload")!.get(0), 7);
      assertEquals(
        table.schema.fields[4].metadata.get("ARROW:extension:name"),
        "org.example.jdv.test",
      );
      assertEquals(
        table.schema.fields[4].metadata.get("ARROW:extension:metadata"),
        "v1",
      );
      assertEquals(table.schema.metadata.get("origin"), "sequential-roundtrip");
      assertEquals(descriptor.mapping, [0, 1, 2, 3, 4]);
      assertEquals(
        descriptor.schema.children.map((field: { name: string }) => field.name),
        ["code", "large", "record", "entries", "payload"],
      );
      assertEquals(descriptor.schema.children[1].format, "+L");
      assertEquals(descriptor.schema.children[2].format, "+s");
      assertEquals(descriptor.schema.children[3].format, "+m");
      assertEquals(descriptor.schema.children[4].metadata_encoding, "hex");
      assert(
        descriptor.schema.children[4].metadata.includes(
          "6f72672e6578616d706c652e6a64762e74657374",
        ),
      );
      const decoded = decodeArrowPage(bytes, descriptor, page, Arrow).rows;
      assertEquals(decoded[0].c0, "red");
      assertEquals(decoded[0].c1, "<list: 2 items>");
      assertEquals(decoded[0].c2, "<struct: 2 fields>");
      assertEquals(decoded[0].c3, "<map>");
    } else {
      const polarsDescriptor =
        JSON.parse(await Deno.readTextFile(`${work}/polars.json`)).params;
      const polars = Arrow.tableFromIPC(
        await Deno.readFile(`${work}/polars.arrows`),
      );
      assertEquals(polarsDescriptor.schema.children[0].format, "vu");
      assertEquals(polars.schema.fields[0].type.typeId, 20);
      assertEquals([
        polars.getChild("label")!.get(0),
        polars.getChild("label")!.get(1),
      ], ["alpha", "beta"]);
      assertEquals(polars.schema.fields[1].type.typeId, 21);
      assertEquals(polars.schema.fields[1].type.children[0].type.typeId, 20);
      assertEquals(Array.from(polars.getChild("values")!.get(0)), ["x", "y"]);
      assertEquals(Array.from(polars.getChild("values")!.get(1)), []);
    }
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

Deno.test({
  name:
    "fresh R encoder preserves dictionary, large list, struct, map, and metadata",
  ignore: !library || !capabilities.arrow || !capabilities.nanoarrow,
  fn: () => roundtrip(false),
});
Deno.test({
  name:
    "optional Polars newest export normalizes views to large UTF8 with exact nested values",
  ignore: !library || !capabilities.nanoarrow || !capabilities.polars,
  fn: () => roundtrip(true),
});
