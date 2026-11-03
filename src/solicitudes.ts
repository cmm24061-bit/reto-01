// Datos para la pantalla de solicitudes: lista de correos y detalle de cada caso.
// Solo LEE fixtures y lo que las herramientas ya escribieron en out/. No usa el modelo ni calcula el mapeo.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { zipSync } from "fflate"
import { type Reglas, type Solicitud, enmascarar, leerJson, listarCasos, rutas } from "./tools/_lib.ts"
import type { Mapeo } from "./tools/_mapeo.ts"

export interface ItemSolicitud {
  caso: string
  de: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  formato: string
  estado: "nuevo" | "procesado" | "enviado"
  listo_para_firma: boolean | null
}

interface EstadoPaquete {
  listo_para_firma: boolean
  motivos_bloqueo: string[]
  checklist: { soportes: { tipo: string; nombre: string; estado: string; vigencia_hasta: string | null }[] }
  archivos: string[]
}

interface FilaPlantilla {
  etiqueta: string
  obligatorio?: boolean
  hoja?: string
  celda_valor?: string
}

export interface FilaCampo {
  etiqueta: string
  estado: "lleno" | "requiere_confirmacion" | "faltante"
  valor: string
  observacion: string
  hoja?: string
  celda?: string
}

function estadoDe(directory: string, caso: string): { estado: ItemSolicitud["estado"]; paquete: EstadoPaquete | null } {
  const dir = rutas.outCaso(directory, caso)
  const paquete = leerJson<EstadoPaquete>(join(dir, "estado-paquete.json"), "paquete")
  const p = paquete.ok ? paquete.data : null
  if (existsSync(join(dir, "ENVIO-SIMULADO.md"))) return { estado: "enviado", paquete: p }
  return { estado: p ? "procesado" : "nuevo", paquete: p }
}

export function solicitudes(directory: string): ItemSolicitud[] {
  const items: ItemSolicitud[] = []
  for (const caso of listarCasos(directory)) {
    const s = leerJson<Solicitud>(join(rutas.caso(directory, caso), "solicitud.json"), "solicitud")
    if (!s.ok) continue
    const { estado, paquete } = estadoDe(directory, caso)
    items.push({
      caso, de: s.data.de, asunto: s.data.asunto, fecha: s.data.fecha, pais: s.data.pais, cliente: s.data.cliente,
      formato: s.data.formato, estado, listo_para_firma: paquete ? paquete.listo_para_firma : null,
    })
  }
  return items.sort((a, b) => b.fecha.localeCompare(a.fecha))
}

const esBancarioSensible = (clave: string) => clave.startsWith("banco.") && clave !== "banco.nombre" && clave !== "banco.tipo_cuenta"

/** Une la plantilla (orden y celdas) con el mapeo guardado por la herramienta, en filas de una línea. */
function filas(plantilla: FilaPlantilla[], mapeo: Mapeo): FilaCampo[] {
  return plantilla.map((p): FilaCampo => {
    const base = { etiqueta: p.etiqueta, hoja: p.hoja, celda: p.celda_valor }
    const lleno = mapeo.llenos.find((c) => c.etiqueta === p.etiqueta)
    if (lleno)
      return { ...base, estado: "lleno", valor: esBancarioSensible(lleno.clave) ? enmascarar(lleno.valor) : lleno.valor, observacion: `maestro · ${lleno.clave}` }
    const conf = mapeo.requiere_confirmacion.find((c) => c.etiqueta === p.etiqueta)
    if (conf)
      return { ...base, estado: "requiere_confirmacion", valor: esBancarioSensible(conf.clave) ? enmascarar(conf.valor_propuesto) : conf.valor_propuesto, observacion: conf.nota }
    const falt = mapeo.faltantes.find((c) => c.etiqueta === p.etiqueta)
    const oblig = p.obligatorio === false ? "campo opcional" : "campo obligatorio"
    const motivo = falt?.motivo.startsWith("La clave") ? "Sin valor en el maestro" : "No existe en el maestro"
    return { ...base, estado: "faltante", valor: "", observacion: `${motivo} · ${oblig}` }
  })
}

function archivos(directory: string, dir: string): string[] {
  if (!existsSync(dir)) return []
  const salida: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) salida.push(...archivos(directory, p))
    else if (!e.name.endsWith(".json") && !e.name.endsWith(".jsonl")) salida.push(relative(directory, p))
  }
  return salida.sort()
}

export function detalle(directory: string, caso: string): Record<string, unknown> | null {
  if (!listarCasos(directory).includes(caso)) return null
  const dirCaso = rutas.caso(directory, caso)
  const s = leerJson<Solicitud>(join(dirCaso, "solicitud.json"), "la solicitud")
  if (!s.ok) return { caso, error: s.error }
  const soportes = leerJson<string[]>(join(dirCaso, "soportes-exigidos.json"), "soportes")
  const plantilla = leerJson<FilaPlantilla[]>(
    join(dirCaso, s.data.formato === "xlsx" ? "plantilla-celdas.json" : "plantilla-campos.json"), "la plantilla",
  )
  const dirOut = rutas.outCaso(directory, caso)
  const mapeo = leerJson<Mapeo>(join(dirOut, "mapeo.json"), "mapeo")
  const { estado, paquete } = estadoDe(directory, caso)
  const reglas = leerJson<Reglas>(rutas.reglas(directory), "reglas")
  const borrador = join(dirOut, "paquete", "borrador-correo.md")
  const nombreForm = s.data.formato === "xlsx" ? "formulario.xlsx" : s.data.formato === "pdf" ? "formulario.pdf" : "valores-portal.md"

  return {
    caso,
    estado,
    correo: s.data,
    extraido: {
      pais_nombre: reglas.ok ? (reglas.data.nombres_paises[s.data.pais] ?? s.data.pais) : s.data.pais,
      identificador: reglas.ok ? (reglas.data.identificador_tributario_por_pais[s.data.pais] ?? "—") : "—",
      campos_solicitados: plantilla.ok ? plantilla.data.length : 0,
      soportes_exigidos: soportes.ok ? soportes.data : [],
      error_plantilla: plantilla.ok ? null : plantilla.error,
    },
    campos: mapeo.ok && plantilla.ok ? filas(plantilla.data, mapeo.data) : null,
    paquete: paquete ? { listo_para_firma: paquete.listo_para_firma, motivos_bloqueo: paquete.motivos_bloqueo, soportes: paquete.checklist.soportes, archivos: paquete.archivos } : null,
    formulario: existsSync(join(dirOut, nombreForm)) ? `out/${caso}/${nombreForm}` : null,
    borrador_correo: existsSync(borrador) ? readFileSync(borrador, "utf8") : null,
    archivos: archivos(directory, dirOut),
  }
}

/** Comprime out/<caso>/paquete/ en memoria. */
export function zipPaquete(directory: string, caso: string): Uint8Array | null {
  if (!listarCasos(directory).includes(caso)) return null
  const dir = join(rutas.outCaso(directory, caso), "paquete")
  if (!existsSync(dir)) return null
  const entradas: Record<string, Uint8Array> = {}
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isFile()) entradas[`paquete-${caso}/${e.name}`] = new Uint8Array(readFileSync(join(dir, e.name)))
  return zipSync(entradas)
}
