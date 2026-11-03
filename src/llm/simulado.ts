// Proveedor "simulado": NO es un modelo de lenguaje. Sigue un guion fijo usando las mismas herramientas.
// Sirve para probar el chat completo sin clave (LLM_PROVIDER=simulado) y en pruebas automáticas.
import type { DefinicionParaModelo, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter.ts"

interface Res {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

const AFIRMATIVO = /^(s[ií]|confirmo|confirmado|env[ií]a|adelante|dale|ok|de acuerdo|procede|hazlo)\b/i

export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "guion-determinista"
  private contador = 0

  constructor(private readonly casos: string[]) {}

  private llamar(nombre: string, args: Record<string, unknown>, texto = ""): RespuestaLLM {
    const llamada: LlamadaHerramienta = { id: `sim_${++this.contador}`, nombre, args }
    return { texto, llamadas: [llamada], uso: { entrada: 0, salida: 0 } }
  }

  private responder(texto: string): RespuestaLLM {
    return { texto, llamadas: [], uso: { entrada: 0, salida: 0 } }
  }

  async enviar(_s: string, mensajes: Mensaje[], _h: DefinicionParaModelo[]): Promise<RespuestaLLM> {
    let iUser = -1
    for (let i = mensajes.length - 1; i >= 0; i--) if (mensajes[i]?.rol === "usuario") { iUser = i; break }
    const user = mensajes[iUser]
    const texto = user && user.rol === "usuario" ? user.texto.trim() : ""
    const resultados = new Map<string, Res>()
    for (const m of mensajes.slice(iUser + 1)) if (m.rol === "resultado_herramienta") resultados.set(m.nombre, JSON.parse(m.contenido) as Res)

    const anterior = mensajes.slice(0, iUser).reverse().find((m) => m.rol === "asistente" && m.llamadas.length === 0)
    const pidioConfirmacion = anterior?.rol === "asistente" && anterior.texto.includes("[CONFIRMACION_REQUERIDA]")
    const casoPrevio = anterior?.rol === "asistente" ? this.casos.find((c) => anterior.texto.includes(c)) : undefined
    const caso = this.casos.find((c) => texto.includes(c))

    if (pidioConfirmacion && casoPrevio && AFIRMATIVO.test(texto) && !/^no\b/i.test(texto)) {
      const envio = resultados.get("proveedor_simular_envio")
      if (!envio) return this.llamar("proveedor_simular_envio", { caso: casoPrevio, confirmado: true })
      return this.responder(envio.ok ? `Listo. Simulé el envío: ${String(envio.data?.ruta)}. No se envió ningún correo real.` : `No pude simular el envío: ${envio.error}`)
    }

    if (!caso) {
      const lista = resultados.get("proveedor_listar_casos")
      if (!lista) return this.llamar("proveedor_listar_casos", {})
      return this.responder(`(Modo simulado, sin modelo de lenguaje.) Escribe el nombre de un caso para procesarlo: ${this.casos.join(", ")}.`)
    }

    const leer = resultados.get("proveedor_leer_solicitud")
    if (!leer) return this.llamar("proveedor_leer_solicitud", { caso })
    if (!leer.ok) return this.responder(`No pude leer la solicitud: ${leer.error}`)
    const mapeo = resultados.get("proveedor_mapear_campos")
    if (!mapeo) return this.llamar("proveedor_mapear_campos", { caso, campos: leer.data?.campos })
    if (!resultados.get("proveedor_generar_formulario")) return this.llamar("proveedor_generar_formulario", { caso })
    const paquete = resultados.get("proveedor_armar_paquete")
    if (!paquete) return this.llamar("proveedor_armar_paquete", { caso })

    const etiquetas = (v: unknown) => (Array.isArray(v) ? v.map((x) => String((x as { etiqueta?: unknown }).etiqueta ?? x)) : [])
    const p = paquete.data ?? {}
    return this.responder(
      [
        `**${caso}** — ${String(leer.data?.cliente)} (${String(leer.data?.pais)}), formato ${String(leer.data?.formato)}`,
        `- Llenos: ${etiquetas(mapeo.data?.llenos).length}`,
        `- Faltantes: ${etiquetas(mapeo.data?.faltantes).join(", ") || "ninguno"}`,
        `- Requieren confirmación: ${etiquetas(mapeo.data?.requiere_confirmacion).join(", ") || "ninguno"}`,
        `- Listo para firma: ${p.listo_para_firma ? "sí" : "no"}`,
        ...etiquetas(p.motivos_bloqueo).map((m) => `  - ${m}`),
        `- Paquete: ${String(p.ruta)}`,
        "",
        `¿Confirmas que simule el envío del paquete de ${caso} al cliente?`,
        "[CONFIRMACION_REQUERIDA]",
      ].join("\n"),
    )
  }
}
