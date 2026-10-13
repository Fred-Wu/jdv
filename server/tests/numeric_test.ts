import { fileURLToPath } from "node:url";

Deno.test("R JSON numbers round-trip as exact finite nonzero doubles", async () => {
  const testLibrary = Deno.env.get("JDV_TEST_R_LIB")?.trim();
  const tempDir = await Deno.makeTempDir({ prefix: "jdv-number-fixture-" });
  try {
    const script = fileURLToPath(
      new URL(
        "./fixtures/export-numbers.R",
        import.meta.url,
      ),
    );
    const env = Deno.env.toObject();
    if (testLibrary) env.R_LIBS_USER = testLibrary;
    const output = await new Deno.Command("Rscript", {
      args: [script, tempDir],
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `R fixture export failed (${output.code}): ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }

    const encoded = await Deno.readTextFile(`${tempDir}/numbers.json`);
    const actual = JSON.parse(encoded) as number[];
    const expected = await Deno.readFile(
      `${tempDir}/expected-little-endian.bin`,
    );
    if (expected.length % 8 !== 0) {
      throw new Error("The R fixture emitted a partial double.");
    }
    if (actual.length !== expected.length / 8) {
      throw new Error(
        `R emitted ${
          expected.length / 8
        } values, JSON.parse read ${actual.length}.`,
      );
    }

    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < actual.length; index++) {
      view.setFloat64(0, actual[index], true);
      const offset = index * 8;
      for (let byte = 0; byte < 8; byte++) {
        if (bytes[byte] !== expected[offset + byte]) {
          throw new Error(
            `Double at index ${index} differs from the R source bits: ${
              actual[index]
            }`,
          );
        }
      }
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
