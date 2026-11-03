// Ejecuta todas las herramientas sobre todos los casos SIN modelo de lenguaje.
// Uso: bun install && bun run demo.ts
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { herramientas } from "./src/tools/registry.ts"
import { listarCasos, fechaEjecucion, type ToolContext } from "./src/tools/_lib.ts"

const directory = resolve(import.meta.dir)
const ctx: ToolContext = { directory, sessionId: "demo" }

interface Respuesta {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Respuesta> {
  const h = herramientas.find((x) => x.nombre === nombre)
  if (!h) return { ok: false, error: `herramienta ${nombre} no encontrada` }
  return JSON.parse(await h.ejecutar(args, ctx)) as Respuesta
}

function lista(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "object" && x !== null && "etiqueta" in x ? String((x as { etiqueta: unknown }).etiqueta) : String(x))) : []
}

// Determinismo: out/ se limpia al inicio.
rmSync(resolve(directory, "out"), { recursive: true, force: true })

console.log(`\n=== Demo sin modelo — fecha de ejecución ${fechaEjecucion()} ===`)

for (const caso of listarCasos(directory)) {
  console.log(`\n── ${caso} ─────────────────────────────`)
  const sol = await llamar("proveedor_leer_solicitud", { caso })
  if (!sol.ok || !sol.data) {
    console.log(`  ✗ leer_solicitud: ${sol.error}`)
    continue
  }
  const d = sol.data
  console.log(`  Cliente: ${d.cliente} · País: ${d.pais} · Formato: ${d.formato}`)
  console.log(`  Campos: ${lista(d.campos).length} · Soportes exigidos: ${lista(d.soportes).join(", ")}`)

  const map = await llamar("proveedor_mapear_campos", { caso, campos: d.campos })
  if (!map.ok || !map.data) {
    console.log(`  ✗ mapear_campos: ${map.error}`)
    continue
  }
  console.log(`  Llenos (${lista(map.data.llenos).length}): ${lista(map.data.llenos).join(", ")}`)
  console.log(`  Faltantes: ${lista(map.data.faltantes).join(", ") || "ninguno"}`)
  console.log(`  Requiere confirmación: ${lista(map.data.requiere_confirmacion).join(", ") || "ninguno"}`)

  const gen = await llamar("proveedor_generar_formulario", { caso })
  console.log(gen.ok ? `  Formulario: ${gen.data?.ruta} — ${gen.data?.mensaje}` : `  ✗ generar_formulario: ${gen.error}`)

  const paq = await llamar("proveedor_armar_paquete", { caso })
  if (paq.ok && paq.data) {
    console.log(`  Paquete: ${paq.data.ruta} · listo_para_firma: ${paq.data.listo_para_firma}`)
    for (const m of lista(paq.data.motivos_bloqueo)) console.log(`    - ${m}`)
  } else console.log(`  ✗ armar_paquete: ${paq.error}`)

  const envioSin = await llamar("proveedor_simular_envio", { caso, confirmado: false })
  console.log(`  Envío sin confirmación → ${envioSin.ok ? "PERMITIDO (error)" : `bloqueado: "${envioSin.error}"`}`)
}

console.log(`\n── Envío con confirmación explícita (ec-corp-andina) ──`)
const envio = await llamar("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: true })
console.log(envio.ok ? `  ✓ ${envio.data?.ruta}${envio.data?.advertencia ? ` (advertencia: ${envio.data.advertencia})` : ""}` : `  ✗ ${envio.error}`)

console.log(`\n── Manejo de errores ──`)
const malo = await llamar("proveedor_leer_solicitud", { caso: "caso-inexistente" })
console.log(`  Caso inexistente → ${malo.error}`)
const invalido = await llamar("proveedor_mapear_campos", { caso: "co-industrias-delta" })
console.log(`  Argumentos inválidos → ${invalido.error}`)
console.log("")
