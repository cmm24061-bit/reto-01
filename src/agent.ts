// Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ErrorLLM, type Mensaje, type ProveedorLLM } from "./llm/adapter.ts"
import { buscarHerramienta, herramientas } from "./tools/registry.ts"
import { asegurarDir, normalizar } from "./tools/_lib.ts"

export interface EventoVisible {
  tipo: "usuario" | "asistente" | "herramienta" | "error"
  texto?: string
  nombre?: string
  args?: unknown
  ok?: boolean
  resumen?: string
  needsConfirmation?: boolean
  ts: string
}

export interface Sesion {
  id: string
  mensajes: Mensaje[]
  eventos: EventoVisible[]
  tokens: number
  esperandoConfirmacion: boolean
}

export interface Config {
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensGlobal: number
}

export interface ResultadoTurno {
  reply: string
  toolCalls: EventoVisible[]
  needsConfirmation: boolean
}

const MARCA = "[CONFIRMACION_REQUERIDA]"
const AFIRMATIVO = /^(si|confirmo|confirmado|envia|enviar|adelante|dale|ok|de acuerdo|procede|hazlo|listo)\b/

let tokensGlobales = 0

/** Una confirmación solo cuenta si el mensaje es afirmativo y no empieza con negación. */
export function esConfirmacion(texto: string): boolean {
  const t = normalizar(texto)
  return AFIRMATIVO.test(t) && !/^no\b/.test(t)
}

export function cargarPrompt(directory: string): string {
  const prompt = readFileSync(join(directory, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return `${prompt}\n\n---\n\n${conocimiento}`
}

const sesiones = new Map<string, Sesion>()

function rutaSesion(directory: string, id: string): string {
  return join(directory, "out", "sesiones", `${id}.json`)
}

export function obtenerSesion(directory: string, id: string): Sesion {
  const enMemoria = sesiones.get(id)
  if (enMemoria) return enMemoria
  const ruta = rutaSesion(directory, id)
  let s: Sesion = { id, mensajes: [], eventos: [], tokens: 0, esperandoConfirmacion: false }
  if (existsSync(ruta)) {
    try {
      s = JSON.parse(readFileSync(ruta, "utf8")) as Sesion
    } catch {
      // archivo dañado: se empieza una sesión nueva
    }
  }
  sesiones.set(id, s)
  return s
}

function guardarSesion(directory: string, s: Sesion): void {
  try {
    asegurarDir(join(directory, "out", "sesiones"))
    writeFileSync(rutaSesion(directory, s.id), JSON.stringify(s))
  } catch {
    // la sesión sigue en memoria
  }
}

function registrarGlobal(directory: string, entrada: Record<string, unknown>): void {
  try {
    asegurarDir(join(directory, "out"))
    appendFileSync(join(directory, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n")
  } catch {
    // el log nunca tumba el turno
  }
}

/** Resumen corto del resultado de una herramienta para mostrar en el chat. */
function resumir(nombre: string, contenido: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(contenido) as { ok: boolean; data?: Record<string, unknown>; error?: string }
    if (!r.ok) return { ok: false, resumen: r.error ?? "error" }
    const d = r.data ?? {}
    const largo = (v: unknown) => (Array.isArray(v) ? v.length : 0)
    switch (nombre) {
      case "proveedor_listar_casos": return { ok: true, resumen: `${largo(d.casos)} casos disponibles` }
      case "proveedor_leer_solicitud": return { ok: true, resumen: `${String(d.cliente)} · ${String(d.pais)} · ${String(d.formato)} · ${largo(d.campos)} campos · ${largo(d.soportes)} soportes` }
      case "proveedor_mapear_campos": return { ok: true, resumen: String(d.resumen) }
      case "proveedor_generar_formulario": return { ok: true, resumen: `${String(d.ruta)}${d.soportado === false ? " (formato no soportado: valores para copiar)" : ""}` }
      case "proveedor_armar_paquete": return { ok: true, resumen: `${String(d.ruta)} · listo_para_firma: ${String(d.listo_para_firma)}` }
      case "proveedor_simular_envio": return { ok: true, resumen: `${String(d.ruta)}` }
      default: return { ok: true, resumen: "ok" }
    }
  } catch {
    return { ok: false, resumen: "respuesta no legible" }
  }
}

export async function procesarTurno(llm: ProveedorLLM, cfg: Config, sesion: Sesion, mensaje: string): Promise<ResultadoTurno> {
  const ahora = () => new Date().toISOString()
  // CA3 / RN4: la confirmación la decide el servidor, no el modelo.
  const confirmacionHumana = sesion.esperandoConfirmacion && esConfirmacion(mensaje)
  sesion.esperandoConfirmacion = false
  sesion.mensajes.push({ rol: "usuario", texto: mensaje })
  sesion.eventos.push({ tipo: "usuario", texto: mensaje, ts: ahora() })

  const sistema = cargarPrompt(cfg.directory)
  const defs = herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, esquema: h.esquema }))
  const toolCalls: EventoVisible[] = []
  let textoFinal = ""
  let paqueteArmado = false
  let envioHecho = false
  let terminado = false

  for (let i = 0; i < cfg.maxIteraciones; i++) {
    if (sesion.tokens >= cfg.maxTokensSesion || tokensGlobales >= cfg.maxTokensGlobal) {
      textoFinal = "Se alcanzó el tope de uso configurado para esta sesión. Abre una sesión nueva o contacta al administrador."
      terminado = true
      break
    }
    let resp
    try {
      resp = await llm.enviar(sistema, sesion.mensajes, defs)
    } catch (e) {
      // CA5: error del proveedor en lenguaje claro; la sesión no muere.
      const msg = e instanceof ErrorLLM ? e.mensajeUsuario : "Ocurrió un error inesperado al consultar el modelo."
      sesion.eventos.push({ tipo: "error", texto: msg, ts: ahora() })
      registrarGlobal(cfg.directory, { sesion: sesion.id, tipo: "error_llm", mensaje: msg })
      // Se quita el mensaje sin respuesta para que el historial quede válido y se pueda reintentar.
      if (toolCalls.length === 0) sesion.mensajes.pop()
      guardarSesion(cfg.directory, sesion)
      return { reply: msg, toolCalls, needsConfirmation: false }
    }
    sesion.tokens += resp.uso.entrada + resp.uso.salida
    tokensGlobales += resp.uso.entrada + resp.uso.salida
    sesion.mensajes.push({ rol: "asistente", texto: resp.texto, llamadas: resp.llamadas })

    if (resp.llamadas.length === 0) {
      textoFinal = resp.texto
      terminado = true
      break
    }

    for (const llamada of resp.llamadas) {
      const h = buscarHerramienta(llamada.nombre)
      const contenido = h
        ? await h.ejecutar(llamada.args, { directory: cfg.directory, sessionId: sesion.id, confirmacionHumana })
        : JSON.stringify({ ok: false, error: `La herramienta ${llamada.nombre} no existe.` })
      const { ok, resumen } = resumir(llamada.nombre, contenido)
      if (ok && llamada.nombre === "proveedor_armar_paquete") paqueteArmado = true
      if (ok && llamada.nombre === "proveedor_simular_envio") envioHecho = true
      sesion.mensajes.push({ rol: "resultado_herramienta", id: llamada.id, nombre: llamada.nombre, contenido })
      const evento: EventoVisible = { tipo: "herramienta", nombre: llamada.nombre, args: llamada.args, ok, resumen, ts: ahora() }
      sesion.eventos.push(evento)
      toolCalls.push(evento)
      // CA4: toda llamada queda en out/log.jsonl
      registrarGlobal(cfg.directory, { sesion: sesion.id, herramienta: llamada.nombre, args: llamada.args, ok, resumen })
    }
  }

  if (!terminado) {
    // CA1: tope de iteraciones
    const hechas = toolCalls.map((t) => `${t.nombre} (${t.ok ? "ok" : "error"})`).join(", ")
    textoFinal = `Alcancé el tope de ${cfg.maxIteraciones} pasos en este turno. Hice: ${hechas || "nada"}. Pídeme continuar para terminar lo que falta.`
    sesion.mensajes.push({ rol: "asistente", texto: textoFinal, llamadas: [] })
  }

  const needsConfirmation = textoFinal.includes(MARCA) || (paqueteArmado && !envioHecho)
  const reply = textoFinal.replaceAll(MARCA, "").trim()
  sesion.esperandoConfirmacion = needsConfirmation
  sesion.eventos.push({ tipo: "asistente", texto: reply, needsConfirmation, ts: ahora() })
  guardarSesion(cfg.directory, sesion)
  return { reply, toolCalls, needsConfirmation }
}
