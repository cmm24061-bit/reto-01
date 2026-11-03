// Utilidades compartidas por las herramientas.
// Este archivo NO exporta herramientas: solo `proveedor.ts` define lo que ve el modelo.
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from "node:fs"
import { join, resolve, sep } from "node:path"

export interface ToolContext {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /** Lo pone el servidor (no el modelo): true solo si el usuario confirmó en este turno una pregunta de confirmación del turno anterior. */
  confirmacionHumana?: boolean
}

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export type Formato = "xlsx" | "pdf" | "portal"

export interface Solicitud {
  id: string
  de: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  cuerpo: string
  formato: string
  adjuntos: string[]
}

export interface CeldaPlantilla {
  hoja: string
  celda_etiqueta: string
  etiqueta: string
  celda_valor: string
}

export interface CampoPlantilla {
  etiqueta: string
  obligatorio: boolean
}

export interface SoporteIndex {
  tipo: string
  archivo: string
  vigencia_hasta: string | null
  pais_emisor: string
  descripcion: string
}

export interface Reglas {
  identificador_tributario_por_pais: Record<string, string>
  pais_del_maestro: string
  clave_identificador_tributario: string
  etiquetas_ambiguas: string[]
  umbral_confianza: number
  umbral_sugerencia: number
  nombres_paises: Record<string, string>
  claves_bancarias_prefijo: string
  nombres_soportes: Record<string, string>
  palabras_vacias: string[]
}

export type JsonValor = string | number | boolean | null | JsonValor[] | { [k: string]: JsonValor }
export type JsonObjeto = { [k: string]: JsonValor }

/** Convierte un resultado tipado en el string JSON que exige el contrato. */
export function responder<T>(r: Resultado<T>): string {
  return JSON.stringify(r)
}

export function ok<T>(data: T): Resultado<T> {
  return { ok: true, data }
}

export function fallo<T>(error: string): Resultado<T> {
  return { ok: false, error }
}

export const rutas = {
  fixtures: (d: string) => join(d, "fixtures", "reto-01"),
  casos: (d: string) => join(d, "fixtures", "reto-01", "casos"),
  caso: (d: string, caso: string) => join(d, "fixtures", "reto-01", "casos", caso),
  maestro: (d: string) => join(d, "fixtures", "reto-01", "repositorio", "maestro.json"),
  soportesDir: (d: string) => join(d, "fixtures", "reto-01", "repositorio", "soportes"),
  glosario: (d: string) => join(d, "fixtures", "reto-01", "glosario-campos.json"),
  reglas: (d: string) => join(d, "src", "knowledge", "reglas.json"),
  out: (d: string) => join(d, "out"),
  outCaso: (d: string, caso: string) => join(d, "out", caso),
}

/** Valida que el nombre del caso sea seguro (sin rutas) y que exista. */
export function validarCaso(directory: string, caso: string): Resultado<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(caso)) {
    return fallo(`El nombre de caso "${caso}" no es válido. Usa el nombre de la carpeta, por ejemplo "ec-corp-andina".`)
  }
  const dir = rutas.caso(directory, caso)
  if (!existsSync(dir)) {
    const disponibles = listarCasos(directory).join(", ")
    return fallo(`El caso "${caso}" no existe. Casos disponibles: ${disponibles || "ninguno"}.`)
  }
  return ok(dir)
}

export function listarCasos(directory: string): string[] {
  const dir = rutas.casos(directory)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** Lee un JSON sin lanzar: devuelve un error legible si no existe o está corrupto. */
export function leerJson<T>(ruta: string, nombre: string): Resultado<T> {
  if (!existsSync(ruta)) return fallo(`No se encontró ${nombre}.`)
  try {
    return ok(JSON.parse(readFileSync(ruta, "utf8")) as T)
  } catch {
    return fallo(`${nombre} está corrupto o no es un JSON válido.`)
  }
}

export function asegurarDir(ruta: string): void {
  mkdirSync(ruta, { recursive: true })
}

/** Evita que una ruta escape de la carpeta base. */
export function dentroDe(base: string, ruta: string): boolean {
  const b = resolve(base) + sep
  return resolve(ruta).startsWith(b)
}

/** Fecha de ejecución (YYYY-MM-DD). Se puede fijar con FECHA_REFERENCIA para pruebas reproducibles. */
export function fechaEjecucion(): string {
  const fija = process.env.FECHA_REFERENCIA
  if (fija && /^\d{4}-\d{2}-\d{2}$/.test(fija)) return fija
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date())
}

/** RN5: registro por caso en out/<caso>/log.jsonl */
export function registrarCaso(directory: string, caso: string, herramienta: string, okFlag: boolean, resumen: string): void {
  try {
    const dir = rutas.outCaso(directory, caso)
    asegurarDir(dir)
    appendFileSync(
      join(dir, "log.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), herramienta, ok: okFlag, resumen }) + "\n",
    )
  } catch {
    // El registro nunca debe tumbar una herramienta.
  }
}

/** Obtiene un valor del maestro por ruta con puntos ("banco.swift"). */
export function valorPorRuta(obj: JsonObjeto, ruta: string): JsonValor | undefined {
  let actual: JsonValor | undefined = obj
  for (const parte of ruta.split(".")) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return undefined
    actual = (actual as JsonObjeto)[parte]
  }
  return actual
}

export function valorATexto(v: JsonValor): string {
  if (v === null) return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function enmascarar(valor: string): string {
  return valor.length <= 4 ? "****" : "****" + valor.slice(-4)
}
