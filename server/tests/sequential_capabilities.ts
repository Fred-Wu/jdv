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
  return capabilitiesFromProbe(process);
}

export function capabilitiesFromProbe(
  process: Pick<Deno.CommandOutput, "success" | "code" | "stdout" | "stderr">,
) {
  if (!process.success) {
    throw new Error(
      `R producer capability probe failed (${process.code}): ${
        new TextDecoder().decode(process.stderr)
      }`,
    );
  }
  const available = new Set(
    capabilityLines(new TextDecoder().decode(process.stdout)),
  );
  return {
    arrow: available.has("arrow"),
    nanoarrow: available.has("nanoarrow"),
    polars: available.has("polars"),
  };
}

export function capabilityLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}
