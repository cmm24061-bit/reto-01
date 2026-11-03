// Las MISMAS herramientas que usa la aplicación (no es una copia): se re-exportan desde src/tools/proveedor.ts.
// Son importables sin el servidor HTTP. Cada export → herramienta `proveedor_<export>`.
export * from "../../src/tools/proveedor.ts"
export type { ToolContext } from "../../src/tools/_lib.ts"
