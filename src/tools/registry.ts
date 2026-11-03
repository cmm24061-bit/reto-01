// Registro de herramientas: convierte cada export de un archivo de herramientas en `<archivo>_<export>`,
// valida los argumentos con zod antes de ejecutar y genera el JSON Schema que ve el modelo.
import { z } from "zod"
import * as proveedor from "./proveedor.ts"
import type { ToolContext } from "./_lib.ts"

export interface DefinicionHerramienta {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: never, ctx: ToolContext) => Promise<string>
}

export interface Herramienta {
  nombre: string
  descripcion: string
  esquema: Record<string, unknown>
  ejecutar: (argsCrudos: unknown, ctx: ToolContext) => Promise<string>
}

function esDefinicion(v: unknown): v is DefinicionHerramienta {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.description === "string" && typeof o.args === "object" && typeof o.execute === "function"
}

function construir(archivo: string, modulo: Record<string, unknown>): Herramienta[] {
  return Object.entries(modulo)
    .filter(([, v]) => esDefinicion(v))
    .map(([exportName, v]) => {
      const def = v as DefinicionHerramienta
      const esquemaZod = z.object(def.args)
      const json = z.toJSONSchema(esquemaZod) as Record<string, unknown>
      delete json.$schema
      return {
        nombre: `${archivo}_${exportName}`,
        descripcion: def.description,
        esquema: json,
        async ejecutar(argsCrudos: unknown, ctx: ToolContext): Promise<string> {
          const parsed = esquemaZod.safeParse(argsCrudos ?? {})
          if (!parsed.success) {
            const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
            return JSON.stringify({ ok: false, error: `Argumentos inválidos: ${detalle}` })
          }
          try {
            return await def.execute(parsed.data as never, ctx)
          } catch {
            return JSON.stringify({ ok: false, error: "La herramienta falló de forma inesperada." })
          }
        },
      }
    })
}

export const herramientas: Herramienta[] = [...construir("proveedor", proveedor as Record<string, unknown>)]

export function buscarHerramienta(nombre: string): Herramienta | undefined {
  return herramientas.find((h) => h.nombre === nombre)
}
