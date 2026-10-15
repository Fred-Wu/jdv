// Probe optional R producers without adding a Deno or R runtime dependency.
export async function sequentialCapabilities(library: string | undefined) {
  if (!library) return { arrow: false, nanoarrow: false, polars: false };
  const process = await new Deno.Command("Rscript", {
    args: [
      "--vanilla",
      "-e",
      ".libPaths(c(commandArgs(TRUE)[[1]],.libPaths())); p <- c('arrow','nanoarrow','polars'); cat(p[vapply(p,requireNamespace,logical(1),quietly=TRUE)],sep='\\n')",
      library,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const available = new Set(
    new TextDecoder().decode(process.stdout).trim().split("\n"),
  );
  return {
    arrow: available.has("arrow"),
    nanoarrow: available.has("nanoarrow"),
    polars: available.has("polars"),
  };
}
